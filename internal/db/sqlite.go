package db

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"my-wails-app/internal/models"
)

type sqliteProvider struct{}

func (p sqliteProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	conn, err := openSQLite(profile)
	if err != nil {
		return err
	}
	defer conn.Close()

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.PingContext(pingCtx)
}

func (p sqliteProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	conn, err := openSQLite(profile)
	if err != nil {
		return models.QueryResult{}, err
	}
	defer conn.Close()
	return executeSQL(ctx, conn, queryText, limit, "", nil)
}

func (p sqliteProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return fmt.Errorf("sqlite query cancellation is handled by context cancellation")
}

func (p sqliteProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	if strings.TrimSpace(profile.FilePath) == "" {
		return nil, fmt.Errorf("sqlite file path is required")
	}
	return []string{"main"}, nil
}

func (p sqliteProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	conn, err := openSQLite(profile)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	defer conn.Close()

	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	tableRows, err := conn.QueryContext(
		queryCtx,
		`SELECT name, type
		 FROM sqlite_master
		 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
		 ORDER BY name`,
	)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list tables: %w", err)
	}
	defer tableRows.Close()

	schema := models.SchemaInfo{Database: "main"}
	for tableRows.Next() {
		var table models.TableInfo
		if err := tableRows.Scan(&table.Name, &table.Type); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("scan table: %w", err)
		}
		schema.Tables = append(schema.Tables, table)
	}
	if err := tableRows.Err(); err != nil {
		return models.SchemaInfo{}, err
	}

	for tableIdx := range schema.Tables {
		table := &schema.Tables[tableIdx]
		columnRows, err := conn.QueryContext(queryCtx, `PRAGMA table_info(`+quoteSQLiteIdentifier(table.Name)+`)`)
		if err != nil {
			return models.SchemaInfo{}, fmt.Errorf("list columns for %s: %w", table.Name, err)
		}
		for columnRows.Next() {
			var cid int
			var notNull int
			var primaryKey int
			var defaultValue interface{}
			var column models.ColumnInfo
			if err := columnRows.Scan(&cid, &column.Name, &column.ColumnType, &notNull, &defaultValue, &primaryKey); err != nil {
				_ = columnRows.Close()
				return models.SchemaInfo{}, fmt.Errorf("scan column: %w", err)
			}
			column.OrdinalPos = cid + 1
			column.DataType = column.ColumnType
			column.Nullable = notNull == 0
			if primaryKey > 0 {
				column.Key = "PRI"
			}
			table.Columns = append(table.Columns, column)
		}
		if err := columnRows.Close(); err != nil {
			return models.SchemaInfo{}, err
		}

		indexRows, err := conn.QueryContext(queryCtx, `PRAGMA index_list(`+quoteSQLiteIdentifier(table.Name)+`)`)
		if err != nil {
			return models.SchemaInfo{}, fmt.Errorf("list indexes for %s: %w", table.Name, err)
		}
		for indexRows.Next() {
			var seq int
			var unique int
			var origin string
			var partial int
			var index models.IndexInfo
			if err := indexRows.Scan(&seq, &index.Name, &unique, &origin, &partial); err != nil {
				_ = indexRows.Close()
				return models.SchemaInfo{}, fmt.Errorf("scan index: %w", err)
			}
			index.Unique = unique == 1
			index.Type = origin
			table.Indexes = append(table.Indexes, index)
		}
		if err := indexRows.Close(); err != nil {
			return models.SchemaInfo{}, err
		}
	}

	return schema, nil
}

func openSQLite(profile models.ConnectionProfile) (*sql.DB, error) {
	if strings.TrimSpace(profile.FilePath) == "" {
		return nil, fmt.Errorf("sqlite file path is required")
	}
	conn, err := sql.Open("sqlite", profile.FilePath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database %s: %w", filepath.Base(profile.FilePath), err)
	}
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	return conn, nil
}

func quoteSQLiteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}
