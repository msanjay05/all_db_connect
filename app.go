package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	workbenchdb "my-wails-app/internal/db"
	"my-wails-app/internal/models"
	"my-wails-app/internal/secure"
	"my-wails-app/internal/store"
)

// App struct
type App struct {
	ctx     context.Context
	store   *store.Store
	secure  *secure.Keyring
	mysql   *workbenchdb.Service
	initErr error

	queryMu     sync.Mutex
	activeQuery *activeQueryState
}

type activeQueryState struct {
	cancel       context.CancelFunc
	profile      models.ConnectionProfile
	password     string
	database     string
	connectionID int64
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		secure: secure.NewKeyring(),
		mysql:  workbenchdb.NewService(),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	dataDir, err := appDataDir()
	if err != nil {
		a.initErr = err
		return
	}

	metadataStore, err := store.Open(filepath.Join(dataDir, "workbench.db"))
	if err != nil {
		a.initErr = err
		return
	}
	a.store = metadataStore
}

func (a *App) ListConnectionProfiles() ([]models.ConnectionProfile, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.store.ListProfiles()
}

func (a *App) SaveConnectionProfile(input models.ConnectionProfileInput) (models.ConnectionProfile, error) {
	if err := a.ready(); err != nil {
		return models.ConnectionProfile{}, err
	}

	normalized, err := normalizeProfileInput(input)
	if err != nil {
		return models.ConnectionProfile{}, err
	}

	existingDatabase := ""
	if normalized.ID != "" {
		if existing, err := a.store.GetProfile(normalized.ID); err == nil {
			existingDatabase = existing.Database
		}
	}

	if normalized.Password != "" {
		if err := a.secure.SetPassword(normalized.ID, normalized.Password); err != nil {
			return models.ConnectionProfile{}, err
		}
	}
	normalized.Database = existingDatabase

	return a.store.UpsertProfile(normalized, time.Now())
}

func (a *App) DeleteConnectionProfile(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("connection id is required")
	}
	if err := a.store.DeleteProfile(id); err != nil {
		return err
	}
	return a.secure.DeletePassword(id)
}

func (a *App) SetDefaultDatabase(connectionID string, database string) (models.ConnectionProfile, error) {
	if err := a.ready(); err != nil {
		return models.ConnectionProfile{}, err
	}
	connectionID = strings.TrimSpace(connectionID)
	database = strings.TrimSpace(database)
	if connectionID == "" {
		return models.ConnectionProfile{}, fmt.Errorf("connection id is required")
	}
	if database == "" {
		return models.ConnectionProfile{}, fmt.Errorf("database is required")
	}
	return a.store.SetDefaultDatabase(connectionID, database)
}

func (a *App) TestConnection(input models.ConnectionProfileInput) (models.ConnectionTestResult, error) {
	if err := a.ready(); err != nil {
		return models.ConnectionTestResult{}, err
	}

	profile, password, err := a.profileAndPassword(input)
	if err != nil {
		return models.ConnectionTestResult{}, err
	}

	if err := a.mysql.TestConnection(a.ctx, profile, password); err != nil {
		return models.ConnectionTestResult{OK: false, Message: err.Error()}, nil
	}
	return models.ConnectionTestResult{OK: true, Message: "Connection successful"}, nil
}

func (a *App) ExecuteQuery(request models.QueryRequest) (models.QueryResult, error) {
	if err := a.ready(); err != nil {
		return models.QueryResult{}, err
	}
	if strings.TrimSpace(request.ConnectionID) == "" {
		return models.QueryResult{}, fmt.Errorf("connection id is required")
	}

	profile, err := a.store.GetProfile(request.ConnectionID)
	if err != nil {
		return models.QueryResult{}, fmt.Errorf("load profile: %w", err)
	}
	password, err := a.secure.GetPassword(profile.ID)
	if err != nil {
		return models.QueryResult{}, err
	}
	if profile.ReadOnly && !isDQLOnly(request.SQL) {
		return models.QueryResult{
			Rows:    []map[string]interface{}{},
			Columns: []models.QueryColumn{},
			Success: false,
			Error:   "Read-only connection only allows DQL queries such as SELECT, SHOW, DESCRIBE, and EXPLAIN",
		}, nil
	}

	selectedDatabase := strings.TrimSpace(request.Database)
	if selectedDatabase == "" {
		return models.QueryResult{}, fmt.Errorf("database is required")
	}

	queryCtx, cancel := context.WithCancel(a.ctx)
	a.setActiveQuery(cancel, profile, password, selectedDatabase)
	defer a.clearQueryCancel()

	result, execErr := a.mysql.Execute(queryCtx, profile, password, selectedDatabase, request.SQL, request.Limit, a.setActiveQueryConnectionID)
	if execErr != nil {
		result.Success = false
		result.Error = execErr.Error()
	}

	rowCount := result.RowsAffected
	if len(result.Rows) > 0 {
		rowCount = int64(len(result.Rows))
	}
	historyID, historyErr := a.store.AddHistory(models.QueryHistory{
		ConnectionID: profile.ID,
		Database:     selectedDatabase,
		SQL:          request.SQL,
		DurationMS:   result.DurationMS,
		RowCount:     rowCount,
		Success:      result.Success,
		Error:        result.Error,
	})
	if historyErr == nil {
		result.HistoryID = historyID
	}

	return result, nil
}

func (a *App) KillQuery() (bool, error) {
	a.queryMu.Lock()
	active := a.activeQuery
	if active == nil {
		a.queryMu.Unlock()
		return false, nil
	}
	active.cancel()
	connectionID := active.connectionID
	profile := active.profile
	password := active.password
	database := active.database
	a.queryMu.Unlock()

	if connectionID <= 0 {
		active.cancel()
		return true, nil
	}
	if err := a.mysql.KillQuery(a.ctx, profile, password, database, connectionID); err != nil {
		active.cancel()
		return true, err
	}
	active.cancel()
	return true, nil
}

func (a *App) ListDatabases(connectionID string) ([]string, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}

	profile, err := a.store.GetProfile(connectionID)
	if err != nil {
		return nil, fmt.Errorf("load profile: %w", err)
	}
	password, err := a.secure.GetPassword(profile.ID)
	if err != nil {
		return nil, err
	}

	return a.mysql.ListDatabases(a.ctx, profile, password)
}

func (a *App) GetSchema(request models.SchemaRequest) (models.SchemaInfo, error) {
	if err := a.ready(); err != nil {
		return models.SchemaInfo{}, err
	}
	if strings.TrimSpace(request.ConnectionID) == "" {
		return models.SchemaInfo{}, fmt.Errorf("connection id is required")
	}
	if strings.TrimSpace(request.Database) == "" {
		return models.SchemaInfo{}, fmt.Errorf("database is required")
	}

	profile, err := a.store.GetProfile(request.ConnectionID)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("load profile: %w", err)
	}
	password, err := a.secure.GetPassword(profile.ID)
	if err != nil {
		return models.SchemaInfo{}, err
	}

	schema, err := a.mysql.Schema(a.ctx, profile, password, request.Database)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	_ = a.store.SaveSchemaCache(request.ConnectionID, schema)
	return schema, nil
}

func (a *App) ListQueryHistory(limit int) ([]models.QueryHistory, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.store.ListHistory(limit)
}

func (a *App) SaveCSVFile(defaultFilename string, content string) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	defaultFilename = sanitizeExportFilename(defaultFilename, "query-results.csv")
	if !strings.HasSuffix(strings.ToLower(defaultFilename), ".csv") {
		defaultFilename += ".csv"
	}

	path, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:                      "Export query results",
		DefaultFilename:            defaultFilename,
		CanCreateDirectories:       true,
		TreatPackagesAsDirectories: true,
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "CSV Files (*.csv)", Pattern: "*.csv"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return "", fmt.Errorf("write csv file: %w", err)
	}
	return path, nil
}

func (a *App) ready() error {
	if a.initErr != nil {
		return a.initErr
	}
	if a.store == nil {
		return fmt.Errorf("application store is not initialized")
	}
	return nil
}

func (a *App) setActiveQuery(cancel context.CancelFunc, profile models.ConnectionProfile, password string, database string) {
	a.queryMu.Lock()
	defer a.queryMu.Unlock()
	a.activeQuery = &activeQueryState{
		cancel:   cancel,
		profile:  profile,
		password: password,
		database: database,
	}
}

func (a *App) setActiveQueryConnectionID(connectionID int64) {
	a.queryMu.Lock()
	defer a.queryMu.Unlock()
	if a.activeQuery != nil {
		a.activeQuery.connectionID = connectionID
	}
}

func (a *App) clearQueryCancel() {
	a.queryMu.Lock()
	defer a.queryMu.Unlock()
	a.activeQuery = nil
}

func (a *App) profileAndPassword(input models.ConnectionProfileInput) (models.ConnectionProfile, string, error) {
	if strings.TrimSpace(input.ID) != "" && strings.TrimSpace(input.Password) == "" {
		profile, err := a.store.GetProfile(input.ID)
		if err != nil {
			return models.ConnectionProfile{}, "", fmt.Errorf("load profile: %w", err)
		}
		password, err := a.secure.GetPassword(input.ID)
		return profile, password, err
	}

	normalized, err := normalizeProfileInput(input)
	if err != nil {
		return models.ConnectionProfile{}, "", err
	}
	return models.ConnectionProfile{
		ID:       normalized.ID,
		Name:     normalized.Name,
		Host:     normalized.Host,
		Port:     normalized.Port,
		Username: normalized.Username,
		Database: normalized.Database,
		ReadOnly: normalized.ReadOnly,
	}, normalized.Password, nil
}

func normalizeProfileInput(input models.ConnectionProfileInput) (models.ConnectionProfileInput, error) {
	input.ID = strings.TrimSpace(input.ID)
	if input.ID == "" {
		input.ID = uuid.NewString()
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Host = strings.TrimSpace(input.Host)
	input.Username = strings.TrimSpace(input.Username)
	input.Database = strings.TrimSpace(input.Database)

	if input.Name == "" {
		input.Name = input.Host
	}
	if input.Host == "" {
		return models.ConnectionProfileInput{}, fmt.Errorf("host is required")
	}
	if input.Port == 0 {
		input.Port = 3306
	}
	if input.Port < 1 || input.Port > 65535 {
		return models.ConnectionProfileInput{}, fmt.Errorf("port must be between 1 and 65535")
	}
	if input.Username == "" {
		return models.ConnectionProfileInput{}, fmt.Errorf("username is required")
	}
	return input, nil
}

func isDQLOnly(sqlText string) bool {
	statements := splitSQLStatements(sqlText)
	if len(statements) == 0 {
		return false
	}
	for _, statement := range statements {
		if !isDQLStatement(statement) {
			return false
		}
	}
	return true
}

func isDQLStatement(statement string) bool {
	keyword := strings.ToUpper(firstSQLKeyword(statement))
	switch keyword {
	case "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN":
		return true
	default:
		return false
	}
}

func firstSQLKeyword(statement string) string {
	statement = strings.TrimSpace(statement)
	for {
		switch {
		case strings.HasPrefix(statement, "--"):
			if idx := strings.IndexByte(statement, '\n'); idx >= 0 {
				statement = strings.TrimSpace(statement[idx+1:])
				continue
			}
			return ""
		case strings.HasPrefix(statement, "#"):
			if idx := strings.IndexByte(statement, '\n'); idx >= 0 {
				statement = strings.TrimSpace(statement[idx+1:])
				continue
			}
			return ""
		case strings.HasPrefix(statement, "/*"):
			if idx := strings.Index(statement, "*/"); idx >= 0 {
				statement = strings.TrimSpace(statement[idx+2:])
				continue
			}
			return ""
		case strings.HasPrefix(statement, "("):
			statement = strings.TrimSpace(statement[1:])
			continue
		}
		break
	}
	for index, char := range statement {
		if !(char == '_' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z') {
			return statement[:index]
		}
	}
	return statement
}

func splitSQLStatements(sqlText string) []string {
	var statements []string
	var current strings.Builder
	var quote rune
	escaped := false
	inLineComment := false
	inBlockComment := false

	for index, char := range sqlText {
		next := rune(0)
		if index+1 < len(sqlText) {
			next = rune(sqlText[index+1])
		}

		if inLineComment {
			current.WriteRune(char)
			if char == '\n' {
				inLineComment = false
			}
			continue
		}
		if inBlockComment {
			current.WriteRune(char)
			if char == '*' && next == '/' {
				inBlockComment = false
			}
			continue
		}
		if quote != 0 {
			current.WriteRune(char)
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == quote {
				quote = 0
			}
			continue
		}

		if char == '-' && next == '-' {
			inLineComment = true
			current.WriteRune(char)
			continue
		}
		if char == '#' {
			inLineComment = true
			current.WriteRune(char)
			continue
		}
		if char == '/' && next == '*' {
			inBlockComment = true
			current.WriteRune(char)
			continue
		}
		if char == '\'' || char == '"' || char == '`' {
			quote = char
			current.WriteRune(char)
			continue
		}
		if char == ';' {
			if statement := strings.TrimSpace(current.String()); statement != "" {
				statements = append(statements, statement)
			}
			current.Reset()
			continue
		}
		current.WriteRune(char)
	}
	if statement := strings.TrimSpace(current.String()); statement != "" {
		statements = append(statements, statement)
	}
	return statements
}

func sanitizeExportFilename(name string, fallback string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return fallback
	}
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-", "\"", "-", "<", "-", ">", "-", "|", "-")
	name = strings.Trim(replacer.Replace(name), ". ")
	if name == "" {
		return fallback
	}
	return name
}

func appDataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find user config directory: %w", err)
	}
	return filepath.Join(base, "my-wails-app"), nil
}
