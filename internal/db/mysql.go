package db

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"my-wails-app/internal/models"
)

type mysqlProvider struct{}

func (p mysqlProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	conn, err := openMySQL(profile, password)
	if err != nil {
		return err
	}
	defer conn.Close()

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.PingContext(pingCtx)
}

func (p mysqlProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	databaseName, err := requireDatabase(databaseName)
	if err != nil {
		return models.QueryResult{}, err
	}
	profile.Database = databaseName
	conn, err := openMySQL(profile, password)
	if err != nil {
		return models.QueryResult{}, err
	}
	defer conn.Close()
	return executeSQL(ctx, conn, queryText, limit, `SELECT CONNECTION_ID()`, onConnectionID)
}

func (p mysqlProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	if connectionID <= 0 {
		return fmt.Errorf("mysql connection id is not available")
	}

	profile.Database = strings.TrimSpace(databaseName)
	db, err := openMySQL(profile, password)
	if err != nil {
		return err
	}
	defer db.Close()

	killCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err = db.ExecContext(killCtx, "KILL QUERY "+strconv.FormatInt(connectionID, 10))
	if err != nil {
		return fmt.Errorf("kill mysql query %d: %w", connectionID, err)
	}
	return nil
}

func (p mysqlProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	conn, err := openMySQL(profile, password)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	rows, err := conn.QueryContext(queryCtx, `SHOW DATABASES`)
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

func (p mysqlProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	profile.Database = strings.TrimSpace(databaseName)
	conn, err := openMySQL(profile, password)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	defer conn.Close()

	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	if strings.TrimSpace(profile.Database) == "" {
		var currentDatabase sql.NullString
		if err := conn.QueryRowContext(queryCtx, `SELECT DATABASE()`).Scan(&currentDatabase); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("read current database: %w", err)
		}
		profile.Database = currentDatabase.String
	}
	if strings.TrimSpace(profile.Database) == "" {
		return models.SchemaInfo{}, fmt.Errorf("database name is required to load schema")
	}

	tableRows, err := conn.QueryContext(
		queryCtx,
		`SELECT TABLE_NAME, TABLE_TYPE, COALESCE(TABLE_ROWS, 0)
		 FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = ?
		 ORDER BY TABLE_NAME`,
		profile.Database,
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
		`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, ORDINAL_POSITION
		 FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = ?
		 ORDER BY TABLE_NAME, ORDINAL_POSITION`,
		profile.Database,
	)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list columns: %w", err)
	}
	defer columnRows.Close()

	for columnRows.Next() {
		var tableName string
		var nullable string
		var column models.ColumnInfo
		if err := columnRows.Scan(&tableName, &column.Name, &column.DataType, &column.ColumnType, &nullable, &column.Key, &column.Extra, &column.OrdinalPos); err != nil {
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

	indexRows, err := conn.QueryContext(
		queryCtx,
		`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',')
		 FROM information_schema.STATISTICS
		 WHERE TABLE_SCHEMA = ?
		 GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE
		 ORDER BY TABLE_NAME, INDEX_NAME`,
		profile.Database,
	)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list indexes: %w", err)
	}
	defer indexRows.Close()

	for indexRows.Next() {
		var tableName string
		var nonUnique int
		var columns string
		var index models.IndexInfo
		if err := indexRows.Scan(&tableName, &index.Name, &nonUnique, &index.Type, &columns); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("scan index: %w", err)
		}
		index.Unique = nonUnique == 0
		if columns != "" {
			index.Columns = strings.Split(columns, ",")
		}
		if idx, ok := tablesByName[tableName]; ok {
			schema.Tables[idx].Indexes = append(schema.Tables[idx].Indexes, index)
		}
	}
	if err := indexRows.Err(); err != nil {
		return models.SchemaInfo{}, err
	}

	return schema, nil
}

func openMySQL(profile models.ConnectionProfile, password string) (*sql.DB, error) {
	port := profile.Port
	if port == 0 {
		port = 3306
	}

	cfg := mysql.NewConfig()
	cfg.User = profile.Username
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = profile.Host + ":" + strconv.Itoa(port)
	cfg.DBName = profile.Database
	cfg.ParseTime = true
	cfg.Timeout = 10 * time.Second
	cfg.ReadTimeout = 2 * time.Minute
	cfg.WriteTimeout = 2 * time.Minute
	cfg.Params = map[string]string{
		"charset":   "utf8mb4",
		"collation": "utf8mb4_unicode_ci",
	}

	conn, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, fmt.Errorf("open mysql connection: %w", err)
	}
	conn.SetMaxOpenConns(3)
	conn.SetMaxIdleConns(1)
	conn.SetConnMaxLifetime(10 * time.Minute)
	return conn, nil
}
