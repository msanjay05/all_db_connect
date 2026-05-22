package main

import (
	"context"
	"encoding/json"
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
	db      *workbenchdb.Service
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
		db:     workbenchdb.NewService(),
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
	if normalized.Database == "" {
		normalized.Database = existingDatabase
	}

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

	if err := a.db.TestConnection(a.ctx, profile, password); err != nil {
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
	if profile.ReadOnly && !isReadOnlyAllowed(profile.Type, request.SQL) {
		return models.QueryResult{
			Rows:    []map[string]interface{}{},
			Columns: []models.QueryColumn{},
			Success: false,
			Error:   readOnlyErrorMessage(profile.Type),
		}, nil
	}

	selectedDatabase := strings.TrimSpace(request.Database)
	if selectedDatabase == "" && workbenchdb.NormalizeType(profile.Type) != workbenchdb.TypeSQLite {
		return models.QueryResult{}, fmt.Errorf("database is required")
	}

	queryCtx, cancel := context.WithCancel(a.ctx)
	a.setActiveQuery(cancel, profile, password, selectedDatabase)
	defer a.clearQueryCancel()

	result, execErr := a.db.Execute(queryCtx, profile, password, selectedDatabase, request.SQL, request.Limit, a.setActiveQueryConnectionID)
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
	if err := a.db.KillQuery(a.ctx, profile, password, database, connectionID); err != nil {
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

	return a.db.ListDatabases(a.ctx, profile, password)
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

	schema, err := a.db.Schema(a.ctx, profile, password, request.Database)
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

func (a *App) ListConnectionQueryHistory(connectionID string, limit int) ([]models.QueryHistory, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return []models.QueryHistory{}, nil
	}
	return a.store.ListHistoryForConnection(connectionID, limit)
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
	normalized, err := normalizeProfileInput(input)
	if err != nil {
		return models.ConnectionProfile{}, "", err
	}
	password := normalized.Password
	if strings.TrimSpace(normalized.ID) != "" && strings.TrimSpace(password) == "" {
		storedPassword, err := a.secure.GetPassword(normalized.ID)
		if err != nil {
			return models.ConnectionProfile{}, "", err
		}
		password = storedPassword
	}
	return models.ConnectionProfile{
		ID:               normalized.ID,
		Type:             normalized.Type,
		Name:             normalized.Name,
		Host:             normalized.Host,
		Port:             normalized.Port,
		Username:         normalized.Username,
		Database:         normalized.Database,
		ConnectionString: normalized.ConnectionString,
		FilePath:         normalized.FilePath,
		Account:          normalized.Account,
		ProjectID:        normalized.ProjectID,
		Region:           normalized.Region,
		Warehouse:        normalized.Warehouse,
		Role:             normalized.Role,
		AuthType:         normalized.AuthType,
		ExtraParams:      normalized.ExtraParams,
		ReadOnly:         normalized.ReadOnly,
	}, password, nil
}

func normalizeProfileInput(input models.ConnectionProfileInput) (models.ConnectionProfileInput, error) {
	input.ID = strings.TrimSpace(input.ID)
	input.Type = workbenchdb.NormalizeType(input.Type)
	if input.ID == "" {
		input.ID = uuid.NewString()
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Host = strings.TrimSpace(input.Host)
	input.Username = strings.TrimSpace(input.Username)
	input.Database = strings.TrimSpace(input.Database)
	input.ConnectionString = strings.TrimSpace(input.ConnectionString)
	input.FilePath = strings.TrimSpace(input.FilePath)
	input.Account = strings.TrimSpace(input.Account)
	input.ProjectID = strings.TrimSpace(input.ProjectID)
	input.Region = strings.TrimSpace(input.Region)
	input.Warehouse = strings.TrimSpace(input.Warehouse)
	input.Role = strings.TrimSpace(input.Role)
	input.AuthType = strings.TrimSpace(input.AuthType)
	input.ExtraParams = strings.TrimSpace(input.ExtraParams)

	if input.Name == "" {
		switch input.Type {
		case workbenchdb.TypeSQLite:
			input.Name = filepath.Base(input.FilePath)
		case workbenchdb.TypeMongoDB:
			input.Name = input.Host
			if input.Name == "" && input.ConnectionString != "" {
				input.Name = "MongoDB"
			}
		case workbenchdb.TypeBigQuery:
			input.Name = firstNonEmpty(input.ProjectID, "BigQuery")
		case workbenchdb.TypeSnowflake:
			input.Name = firstNonEmpty(input.Account, "Snowflake")
		default:
			input.Name = firstNonEmpty(input.Host, input.ConnectionString, input.Type)
		}
	}

	switch input.Type {
	case workbenchdb.TypeMySQL, workbenchdb.TypePostgres, workbenchdb.TypeRedshift, workbenchdb.TypeClickHouse, workbenchdb.TypePresto, workbenchdb.TypeStarburst, workbenchdb.TypeSQLServer:
		if input.Host == "" && input.ConnectionString == "" {
			return models.ConnectionProfileInput{}, fmt.Errorf("host is required")
		}
		if input.Port == 0 {
			switch input.Type {
			case workbenchdb.TypePostgres:
				input.Port = 5432
			case workbenchdb.TypeRedshift:
				input.Port = 5439
			case workbenchdb.TypeClickHouse:
				input.Port = 9000
			case workbenchdb.TypePresto, workbenchdb.TypeStarburst:
				input.Port = 8080
			case workbenchdb.TypeSQLServer:
				input.Port = 1433
			default:
				input.Port = 3306
			}
		}
		if input.Port < 1 || input.Port > 65535 {
			return models.ConnectionProfileInput{}, fmt.Errorf("port must be between 1 and 65535")
		}
		if input.Username == "" && input.ConnectionString == "" {
			return models.ConnectionProfileInput{}, fmt.Errorf("username is required")
		}
	case workbenchdb.TypeMongoDB:
		if input.ConnectionString == "" && input.Host == "" {
			input.Host = "localhost"
		}
		if input.Port == 0 && input.ConnectionString == "" {
			input.Port = 27017
		}
		if input.Port < 0 || input.Port > 65535 {
			return models.ConnectionProfileInput{}, fmt.Errorf("port must be between 1 and 65535")
		}
	case workbenchdb.TypeSQLite:
		if input.FilePath == "" {
			return models.ConnectionProfileInput{}, fmt.Errorf("sqlite file path is required")
		}
		input.Host = ""
		input.Port = 0
		input.Username = ""
		input.Password = ""
	case workbenchdb.TypeBigQuery:
		if input.ProjectID == "" && input.Database == "" {
			return models.ConnectionProfileInput{}, fmt.Errorf("bigquery project id is required")
		}
	case workbenchdb.TypeAthena:
		if input.Region == "" {
			input.Region = "us-east-1"
		}
	case workbenchdb.TypeSnowflake:
		if input.ConnectionString == "" && (input.Account == "" || input.Username == "") {
			return models.ConnectionProfileInput{}, fmt.Errorf("snowflake account and username are required")
		}
	case workbenchdb.TypeDatabricks, workbenchdb.TypeDruid, workbenchdb.TypeDruidJDBC, workbenchdb.TypeSparkSQL:
		if input.Host == "" && input.ConnectionString == "" {
			return models.ConnectionProfileInput{}, fmt.Errorf("host or connection string is required")
		}
	default:
		return models.ConnectionProfileInput{}, fmt.Errorf("unsupported database type %q", input.Type)
	}
	return input, nil
}

func isReadOnlyAllowed(profileType string, queryText string) bool {
	if workbenchdb.NormalizeType(profileType) == workbenchdb.TypeMongoDB {
		return isMongoReadOnlyCommand(queryText)
	}
	return isDQLOnly(queryText)
}

func readOnlyErrorMessage(profileType string) string {
	if workbenchdb.NormalizeType(profileType) == workbenchdb.TypeMongoDB {
		return "Read-only MongoDB connections only allow read commands such as find, aggregate, count, distinct, listCollections, and listIndexes"
	}
	return "Read-only connection only allows DQL queries such as SELECT, SHOW, DESCRIBE, and EXPLAIN"
}

func isMongoReadOnlyCommand(queryText string) bool {
	var command map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(queryText)), &command); err != nil {
		return false
	}
	if len(command) == 0 {
		return false
	}
	readCommands := map[string]bool{
		"aggregate":       true,
		"count":           true,
		"distinct":        true,
		"find":            true,
		"listcollections": true,
		"listdatabases":   true,
		"listindexes":     true,
	}
	for key := range command {
		return readCommands[strings.ToLower(key)]
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
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
