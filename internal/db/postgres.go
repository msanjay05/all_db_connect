package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"my-wails-app/internal/models"
)

type postgresProvider struct{}

func (p postgresProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	conn, err := openPostgres(profile, password)
	if err != nil {
		return err
	}
	defer conn.Close()

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.PingContext(pingCtx)
}

func (p postgresProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	databaseName = strings.TrimSpace(databaseName)
	if inferred := InferDatabaseFromSQL(queryText); inferred != "" {
		databaseName = inferred
	}
	var err error
	databaseName, err = requireDatabase(databaseName)
	if err != nil {
		return models.QueryResult{}, err
	}
	profile.Database = databaseName
	conn, err := openPostgres(profile, password)
	if err != nil {
		return models.QueryResult{}, err
	}
	defer conn.Close()

	execSQLText := queryText
	if containsDatabasePrefix(queryText, databaseName) {
		if !schemaExists(ctx, conn, databaseName) {
			execSQLText = stripDatabasePrefix(queryText, databaseName)
		}
	}

	res, execErr := executeSQL(ctx, conn, execSQLText, limit, `SELECT pg_backend_pid()`, onConnectionID)
	if execErr != nil && execSQLText == queryText && containsDatabasePrefix(queryText, databaseName) {
		fallbackSQL := stripDatabasePrefix(queryText, databaseName)
		if fallbackSQL != queryText {
			if retryRes, retryErr := executeSQL(ctx, conn, fallbackSQL, limit, `SELECT pg_backend_pid()`, onConnectionID); retryErr == nil {
				return retryRes, nil
			}
		}
	}
	return res, execErr
}

func containsDatabasePrefix(sqlText, dbName string) bool {
	dbName = strings.TrimSpace(dbName)
	if dbName == "" {
		return false
	}
	pattern := `(?i)(?:^|[^A-Za-z0-9_$])(?:` + regexp.QuoteMeta(dbName) + `|"` + regexp.QuoteMeta(dbName) + `"|` + "`" + regexp.QuoteMeta(dbName) + "`" + `)\.`
	re, err := regexp.Compile(pattern)
	if err != nil {
		return false
	}
	return re.MatchString(sqlText)
}

func stripDatabasePrefix(sqlText, dbName string) string {
	dbName = strings.TrimSpace(dbName)
	if dbName == "" {
		return sqlText
	}
	pattern := `(?i)(^|[^A-Za-z0-9_$])(?:` + regexp.QuoteMeta(dbName) + `|"` + regexp.QuoteMeta(dbName) + `"|` + "`" + regexp.QuoteMeta(dbName) + "`" + `)\.([A-Za-z0-9_$]+|"[^"]+"|\x60[^\x60]+\x60)`
	re, err := regexp.Compile(pattern)
	if err != nil {
		return sqlText
	}
	return re.ReplaceAllString(sqlText, "${1}${2}")
}

func schemaExists(ctx context.Context, conn *sql.DB, schemaName string) bool {
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var exists bool
	_ = conn.QueryRowContext(checkCtx, `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = $1)`, schemaName).Scan(&exists)
	return exists
}

func (p postgresProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	if connectionID <= 0 {
		return fmt.Errorf("postgres backend pid is not available")
	}

	profile.Database = strings.TrimSpace(databaseName)
	db, err := openPostgres(profile, password)
	if err != nil {
		return err
	}
	defer db.Close()

	killCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err = db.ExecContext(killCtx, `SELECT pg_cancel_backend($1)`, connectionID)
	if err != nil {
		return fmt.Errorf("cancel postgres query %d: %w", connectionID, err)
	}
	return nil
}

func (p postgresProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	conn, err := openPostgres(profile, password)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	rows, err := conn.QueryContext(queryCtx, `SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname`)
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	defer rows.Close()

	var databases []string
	for rows.Next() {
		var database string
		if err := rows.Scan(&database); err != nil {
			return nil, fmt.Errorf("scan database: %w", err)
		}
		databases = append(databases, database)
	}
	return databases, rows.Err()
}

func (p postgresProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	profile.Database = strings.TrimSpace(databaseName)
	if profile.Database == "" {
		return models.SchemaInfo{}, fmt.Errorf("database name is required to load schema")
	}

	conn, err := openPostgres(profile, password)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	defer conn.Close()

	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	tableRows, err := conn.QueryContext(
		queryCtx,
		`SELECT
			t.table_name,
			t.table_type,
			COALESCE(
				CASE
					WHEN s.n_live_tup IS NOT NULL AND s.n_live_tup > 0 THEN s.n_live_tup
					WHEN c.reltuples > 0 THEN c.reltuples::bigint
					ELSE COALESCE(s.n_live_tup, 0)
				END,
				0
			) AS row_count
		 FROM information_schema.tables t
		 LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
		 LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
		 LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name AND s.schemaname = t.table_schema
		 WHERE t.table_schema = 'public'
		 ORDER BY t.table_name`,
	)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list tables: %w", err)
	}
	defer tableRows.Close()

	tablesByName := map[string]int{}
	schema := models.SchemaInfo{Database: profile.Database}
	for tableRows.Next() {
		var table models.TableInfo
		if err := tableRows.Scan(&table.Name, &table.Type, &table.RowCount); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("scan table: %w", err)
		}
		tablesByName[table.Name] = len(schema.Tables)
		schema.Tables = append(schema.Tables, table)
	}
	if err := tableRows.Err(); err != nil {
		return models.SchemaInfo{}, err
	}

	columnRows, err := conn.QueryContext(
		queryCtx,
		`SELECT table_name, column_name, data_type, udt_name, is_nullable, ordinal_position
		 FROM information_schema.columns
		 WHERE table_schema = 'public'
		 ORDER BY table_name, ordinal_position`,
	)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list columns: %w", err)
	}
	defer columnRows.Close()

	for columnRows.Next() {
		var tableName string
		var nullable string
		var column models.ColumnInfo
		if err := columnRows.Scan(&tableName, &column.Name, &column.DataType, &column.ColumnType, &nullable, &column.OrdinalPos); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("scan column: %w", err)
		}
		column.Nullable = nullable == "YES"
		if idx, ok := tablesByName[tableName]; ok {
			schema.Tables[idx].Columns = append(schema.Tables[idx].Columns, column)
		}
	}
	if err := columnRows.Err(); err != nil {
		return models.SchemaInfo{}, err
	}

	primaryRows, err := conn.QueryContext(
		queryCtx,
		`SELECT kcu.table_name, kcu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
		 WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`,
	)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list primary keys: %w", err)
	}
	defer primaryRows.Close()

	for primaryRows.Next() {
		var tableName, columnName string
		if err := primaryRows.Scan(&tableName, &columnName); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("scan primary key: %w", err)
		}
		if idx, ok := tablesByName[tableName]; ok {
			for colIdx := range schema.Tables[idx].Columns {
				if schema.Tables[idx].Columns[colIdx].Name == columnName {
					schema.Tables[idx].Columns[colIdx].Key = "PRI"
					break
				}
			}
		}
	}
	if err := primaryRows.Err(); err != nil {
		return models.SchemaInfo{}, err
	}

	indexRows, err := conn.QueryContext(
		queryCtx,
		`SELECT tablename, indexname, indexdef
		 FROM pg_indexes
		 WHERE schemaname = 'public'
		 ORDER BY tablename, indexname`,
	)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list indexes: %w", err)
	}
	defer indexRows.Close()

	for indexRows.Next() {
		var tableName, indexDef string
		var index models.IndexInfo
		if err := indexRows.Scan(&tableName, &index.Name, &indexDef); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("scan index: %w", err)
		}
		index.Unique = strings.Contains(strings.ToUpper(indexDef), "UNIQUE INDEX")
		index.Type = "BTREE"
		if idx, ok := tablesByName[tableName]; ok {
			schema.Tables[idx].Indexes = append(schema.Tables[idx].Indexes, index)
		}
	}
	return schema, indexRows.Err()
}

func openPostgres(profile models.ConnectionProfile, password string) (*sql.DB, error) {
	if strings.TrimSpace(profile.ConnectionString) != "" {
		conn, err := sql.Open("pgx", profile.ConnectionString)
		if err != nil {
			return nil, fmt.Errorf("open postgres connection: %w", err)
		}
		return conn, nil
	}

	port := profile.Port
	if port == 0 {
		port = 5432
	}
	values := url.Values{}
	values.Set("sslmode", "prefer")
	databaseName := profile.Database
	if strings.TrimSpace(databaseName) == "" {
		databaseName = "postgres"
	}
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(profile.Username, password),
		Host:     profile.Host + ":" + strconv.Itoa(port),
		Path:     "/" + databaseName,
		RawQuery: values.Encode(),
	}

	conn, err := sql.Open("pgx", u.String())
	if err != nil {
		return nil, fmt.Errorf("open postgres connection: %w", err)
	}
	conn.SetMaxOpenConns(3)
	conn.SetMaxIdleConns(1)
	conn.SetConnMaxLifetime(10 * time.Minute)
	return conn, nil
}
