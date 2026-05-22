package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"my-wails-app/internal/models"
)

type sqlOpenFunc func(profile models.ConnectionProfile, password string, databaseName string) (*sql.DB, error)

type sqlProvider struct {
	name            string
	open            sqlOpenFunc
	requireDatabase bool
	connectionIDSQL string
	listDatabases   func(context.Context, models.ConnectionProfile, string) ([]string, error)
	schema          func(context.Context, models.ConnectionProfile, string, string) (models.SchemaInfo, error)
	killQuery       func(context.Context, models.ConnectionProfile, string, string, int64) error
}

func (p sqlProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	conn, err := p.open(profile, password, profile.Database)
	if err != nil {
		return err
	}
	defer conn.Close()

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.PingContext(pingCtx)
}

func (p sqlProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	if p.requireDatabase {
		var err error
		databaseName, err = requireDatabase(databaseName)
		if err != nil {
			return models.QueryResult{}, err
		}
	}
	conn, err := p.open(profile, password, databaseName)
	if err != nil {
		return models.QueryResult{}, err
	}
	defer conn.Close()
	return executeSQL(ctx, conn, queryText, limit, p.connectionIDSQL, onConnectionID)
}

func (p sqlProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	if p.killQuery != nil {
		return p.killQuery(ctx, profile, password, databaseName, connectionID)
	}
	return fmt.Errorf("%s query cancellation is handled by context cancellation", p.name)
}

func (p sqlProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	if p.listDatabases != nil {
		return p.listDatabases(ctx, profile, password)
	}
	if strings.TrimSpace(profile.Database) != "" {
		return []string{profile.Database}, nil
	}
	return []string{"default"}, nil
}

func (p sqlProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	if p.schema != nil {
		return p.schema(ctx, profile, password, databaseName)
	}
	conn, err := p.open(profile, password, databaseName)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	defer conn.Close()
	return schemaFromShowTables(ctx, conn, databaseName)
}

func schemaFromShowTables(ctx context.Context, conn *sql.DB, databaseName string) (models.SchemaInfo, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	rows, err := conn.QueryContext(queryCtx, `SHOW TABLES`)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list tables: %w", err)
	}
	defer rows.Close()
	columnNames, err := rows.Columns()
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("read table columns: %w", err)
	}

	schema := models.SchemaInfo{Database: databaseName}
	for rows.Next() {
		values := make([]interface{}, len(columnNames))
		targets := make([]interface{}, len(values))
		for index := range targets {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("scan table: %w", err)
		}
		if name := firstStringValue(values); name != "" {
			schema.Tables = append(schema.Tables, models.TableInfo{Name: name, Type: "TABLE"})
		}
	}
	if err := rows.Err(); err != nil {
		return models.SchemaInfo{}, err
	}
	sort.Slice(schema.Tables, func(i, j int) bool {
		return strings.ToLower(schema.Tables[i].Name) < strings.ToLower(schema.Tables[j].Name)
	})
	return schema, nil
}

func firstStringValue(values []interface{}) string {
	for _, value := range values {
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				return typed
			}
		case []byte:
			if strings.TrimSpace(string(typed)) != "" {
				return string(typed)
			}
		}
	}
	return ""
}

func extraParams(profile models.ConnectionProfile) map[string]string {
	params := map[string]string{}
	raw := strings.TrimSpace(profile.ExtraParams)
	if raw == "" {
		return params
	}
	var decoded map[string]interface{}
	if json.Unmarshal([]byte(raw), &decoded) == nil {
		for key, value := range decoded {
			params[key] = fmt.Sprint(value)
		}
		return params
	}
	values, err := url.ParseQuery(raw)
	if err == nil {
		for key, value := range values {
			if len(value) > 0 {
				params[key] = value[0]
			}
		}
	}
	return params
}

func intParam(params map[string]string, key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(params[key]))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func stringParam(params map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(params[key]); value != "" {
			return value
		}
	}
	return ""
}
