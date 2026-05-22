package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	_ "github.com/ClickHouse/clickhouse-go/v2"
	_ "github.com/denisenkom/go-mssqldb"
	_ "github.com/prestodb/presto-go-client/presto"
	"github.com/snowflakedb/gosnowflake"

	"my-wails-app/internal/models"
)

type redshiftProvider struct{}

func (p redshiftProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	profile.Port = defaultPort(profile.Port, 5439)
	return postgresProvider{}.TestConnection(ctx, profile, password)
}

func (p redshiftProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	profile.Port = defaultPort(profile.Port, 5439)
	return postgresProvider{}.Execute(ctx, profile, password, databaseName, queryText, limit, onConnectionID)
}

func (p redshiftProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	profile.Port = defaultPort(profile.Port, 5439)
	return postgresProvider{}.KillQuery(ctx, profile, password, databaseName, connectionID)
}

func (p redshiftProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	profile.Port = defaultPort(profile.Port, 5439)
	return postgresProvider{}.ListDatabases(ctx, profile, password)
}

func (p redshiftProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	profile.Port = defaultPort(profile.Port, 5439)
	return postgresProvider{}.Schema(ctx, profile, password, databaseName)
}

type clickHouseProvider struct{ sqlProvider }

func (p clickHouseProvider) provider() sqlProvider {
	return sqlProvider{
		name:            "ClickHouse",
		open:            openClickHouse,
		requireDatabase: false,
		listDatabases:   listDatabasesByQuery(openClickHouse, `SHOW DATABASES`),
	}
}

func (p clickHouseProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	return p.provider().TestConnection(ctx, profile, password)
}
func (p clickHouseProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	return p.provider().Execute(ctx, profile, password, databaseName, queryText, limit, onConnectionID)
}
func (p clickHouseProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return p.provider().KillQuery(ctx, profile, password, databaseName, connectionID)
}
func (p clickHouseProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	return p.provider().ListDatabases(ctx, profile, password)
}
func (p clickHouseProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	return p.provider().Schema(ctx, profile, password, databaseName)
}

type prestoProvider struct{ sqlProvider }

func (p prestoProvider) provider() sqlProvider {
	return sqlProvider{
		name:            "Presto",
		open:            openPresto,
		requireDatabase: false,
		listDatabases:   listDatabasesByQuery(openPresto, `SHOW CATALOGS`),
	}
}

func (p prestoProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	return p.provider().TestConnection(ctx, profile, password)
}
func (p prestoProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	return p.provider().Execute(ctx, profile, password, databaseName, queryText, limit, onConnectionID)
}
func (p prestoProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return p.provider().KillQuery(ctx, profile, password, databaseName, connectionID)
}
func (p prestoProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	return p.provider().ListDatabases(ctx, profile, password)
}
func (p prestoProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	return p.provider().Schema(ctx, profile, password, databaseName)
}

type snowflakeProvider struct{ sqlProvider }

func (p snowflakeProvider) provider() sqlProvider {
	return sqlProvider{
		name:            "Snowflake",
		open:            openSnowflake,
		requireDatabase: false,
		listDatabases:   listDatabasesByQuery(openSnowflake, `SHOW DATABASES`),
		schema:          snowflakeSchema,
	}
}

func (p snowflakeProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	return p.provider().TestConnection(ctx, profile, password)
}
func (p snowflakeProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	return p.provider().Execute(ctx, profile, password, databaseName, queryText, limit, onConnectionID)
}
func (p snowflakeProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return p.provider().KillQuery(ctx, profile, password, databaseName, connectionID)
}
func (p snowflakeProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	return p.provider().ListDatabases(ctx, profile, password)
}
func (p snowflakeProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	return p.provider().Schema(ctx, profile, password, databaseName)
}

type sqlServerProvider struct{ sqlProvider }

func (p sqlServerProvider) provider() sqlProvider {
	return sqlProvider{
		name:            "SQL Server",
		open:            openSQLServer,
		requireDatabase: false,
		listDatabases:   listDatabasesByQuery(openSQLServer, `SELECT name FROM sys.databases ORDER BY name`),
		schema:          sqlServerSchema,
	}
}

func (p sqlServerProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	return p.provider().TestConnection(ctx, profile, password)
}
func (p sqlServerProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	return p.provider().Execute(ctx, profile, password, databaseName, queryText, limit, onConnectionID)
}
func (p sqlServerProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return p.provider().KillQuery(ctx, profile, password, databaseName, connectionID)
}
func (p sqlServerProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	return p.provider().ListDatabases(ctx, profile, password)
}
func (p sqlServerProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	return p.provider().Schema(ctx, profile, password, databaseName)
}

func openClickHouse(profile models.ConnectionProfile, password string, databaseName string) (*sql.DB, error) {
	if strings.TrimSpace(profile.ConnectionString) != "" {
		return openSQL("clickhouse", profile.ConnectionString, "clickhouse")
	}
	port := defaultPort(profile.Port, 9000)
	database := firstNonEmpty(databaseName, profile.Database, "default")
	u := url.URL{
		Scheme: "clickhouse",
		User:   url.UserPassword(profile.Username, password),
		Host:   profile.Host + ":" + strconv.Itoa(port),
		Path:   "/" + database,
	}
	u.RawQuery = extraQuery(profile).Encode()
	return openSQL("clickhouse", u.String(), "clickhouse")
}

func openPresto(profile models.ConnectionProfile, password string, databaseName string) (*sql.DB, error) {
	if strings.TrimSpace(profile.ConnectionString) != "" {
		return openSQL("presto", profile.ConnectionString, "presto")
	}
	params := extraQuery(profile)
	if params.Get("catalog") == "" {
		params.Set("catalog", firstNonEmpty(databaseName, profile.Database, "hive"))
	}
	if params.Get("schema") == "" {
		params.Set("schema", firstNonEmpty(profile.Warehouse, "default"))
	}
	scheme := firstNonEmpty(params.Get("scheme"), "http")
	params.Del("scheme")
	u := url.URL{
		Scheme:   scheme,
		User:     url.User(profile.Username),
		Host:     profile.Host + ":" + strconv.Itoa(defaultPort(profile.Port, 8080)),
		RawQuery: params.Encode(),
	}
	return openSQL("presto", u.String(), "presto")
}

func openSnowflake(profile models.ConnectionProfile, password string, databaseName string) (*sql.DB, error) {
	if strings.TrimSpace(profile.ConnectionString) != "" {
		return openSQL("snowflake", profile.ConnectionString, "snowflake")
	}
	config := &gosnowflake.Config{
		Account:   profile.Account,
		User:      profile.Username,
		Password:  password,
		Database:  firstNonEmpty(databaseName, profile.Database),
		Schema:    firstNonEmpty(profile.Warehouse, "PUBLIC"),
		Warehouse: profile.Warehouse,
		Role:      profile.Role,
	}
	dsn, err := gosnowflake.DSN(config)
	if err != nil {
		return nil, fmt.Errorf("build snowflake dsn: %w", err)
	}
	return openSQL("snowflake", dsn, "snowflake")
}

func openSQLServer(profile models.ConnectionProfile, password string, databaseName string) (*sql.DB, error) {
	if strings.TrimSpace(profile.ConnectionString) != "" {
		return openSQL("sqlserver", profile.ConnectionString, "sql server")
	}
	params := extraQuery(profile)
	if dbName := firstNonEmpty(databaseName, profile.Database); dbName != "" {
		params.Set("database", dbName)
	}
	u := url.URL{
		Scheme:   "sqlserver",
		User:     url.UserPassword(profile.Username, password),
		Host:     profile.Host + ":" + strconv.Itoa(defaultPort(profile.Port, 1433)),
		RawQuery: params.Encode(),
	}
	return openSQL("sqlserver", u.String(), "sql server")
}

func openSQL(driverName string, dsn string, label string) (*sql.DB, error) {
	conn, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s connection: %w", label, err)
	}
	conn.SetMaxOpenConns(3)
	conn.SetMaxIdleConns(1)
	conn.SetConnMaxLifetime(10 * time.Minute)
	return conn, nil
}

func listDatabasesByQuery(open sqlOpenFunc, query string) func(context.Context, models.ConnectionProfile, string) ([]string, error) {
	return func(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
		conn, err := open(profile, password, profile.Database)
		if err != nil {
			return nil, err
		}
		defer conn.Close()
		queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		rows, err := conn.QueryContext(queryCtx, query)
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
}

func snowflakeSchema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	conn, err := openSnowflake(profile, password, databaseName)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	defer conn.Close()
	return schemaFromShowTables(ctx, conn, databaseName)
}

func sqlServerSchema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	conn, err := openSQLServer(profile, password, databaseName)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	defer conn.Close()
	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	rows, err := conn.QueryContext(queryCtx, `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`)
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list tables: %w", err)
	}
	defer rows.Close()
	schema := models.SchemaInfo{Database: databaseName}
	for rows.Next() {
		var table models.TableInfo
		if err := rows.Scan(&table.Name, &table.Type); err != nil {
			return models.SchemaInfo{}, fmt.Errorf("scan table: %w", err)
		}
		schema.Tables = append(schema.Tables, table)
	}
	return schema, rows.Err()
}

func extraQuery(profile models.ConnectionProfile) url.Values {
	values := url.Values{}
	for key, value := range extraParams(profile) {
		values.Set(key, value)
	}
	return values
}

func defaultPort(value int, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
