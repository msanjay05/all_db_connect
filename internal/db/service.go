package db

import (
	"context"
	"fmt"
	"strings"

	"my-wails-app/internal/models"
)

const (
	TypeAthena     = "athena"
	TypeBigQuery   = "bigquery"
	TypeClickHouse = "clickhouse"
	TypeDatabricks = "databricks"
	TypeDruid      = "druid"
	TypeDruidJDBC  = "druid-jdbc"
	TypeMongoDB    = "mongodb"
	TypeMySQL      = "mysql"
	TypePostgres   = "postgres"
	TypePresto     = "presto"
	TypeRedshift   = "redshift"
	TypeSnowflake  = "snowflake"
	TypeSparkSQL   = "spark-sql"
	TypeStarburst  = "starburst"
	TypeSQLServer  = "sqlserver"
	TypeSQLite     = "sqlite"
)

type Provider interface {
	TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error
	Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error)
	KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error
	ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error)
	Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error)
}

type Service struct {
	providers map[string]Provider
}

func NewService() *Service {
	return &Service{
		providers: map[string]Provider{
			TypeAthena:     athenaProvider{},
			TypeBigQuery:   bigQueryProvider{},
			TypeClickHouse: clickHouseProvider{},
			TypeDatabricks: databricksProvider{},
			TypeDruid:      druidProvider{},
			TypeDruidJDBC:  druidProvider{avatica: true},
			TypeMongoDB:    mongoProvider{},
			TypeMySQL:      mysqlProvider{},
			TypePostgres:   postgresProvider{},
			TypePresto:     prestoProvider{},
			TypeRedshift:   redshiftProvider{},
			TypeSnowflake:  snowflakeProvider{},
			TypeSparkSQL:   sparkSQLProvider{},
			TypeStarburst:  prestoProvider{},
			TypeSQLServer:  sqlServerProvider{},
			TypeSQLite:     sqliteProvider{},
		},
	}
}

func NormalizeType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", TypeMySQL:
		return TypeMySQL
	case "amazon-athena", "amazon athena", TypeAthena:
		return TypeAthena
	case "google-bigquery", "google bigquery", "big query", TypeBigQuery:
		return TypeBigQuery
	case "click-house", TypeClickHouse:
		return TypeClickHouse
	case "data-bricks", TypeDatabricks:
		return TypeDatabricks
	case TypeDruid:
		return TypeDruid
	case "druidjdbc", "druid_jdbc", "druid jdbc", TypeDruidJDBC:
		return TypeDruidJDBC
	case "postgresql", "pg", TypePostgres:
		return TypePostgres
	case "mongo", TypeMongoDB:
		return TypeMongoDB
	case TypePresto:
		return TypePresto
	case "amazon-redshift", "amazon redshift", TypeRedshift:
		return TypeRedshift
	case "snow-flake", TypeSnowflake:
		return TypeSnowflake
	case "spark", "spark sql", TypeSparkSQL:
		return TypeSparkSQL
	case "trino", "starburst trino", "starburst-trino", TypeStarburst:
		return TypeStarburst
	case "mssql", "sql-server", "sql server", TypeSQLServer:
		return TypeSQLServer
	case TypeSQLite:
		return TypeSQLite
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func IsSQLType(value string) bool {
	switch NormalizeType(value) {
	case TypeAthena, TypeBigQuery, TypeClickHouse, TypeDatabricks, TypeDruid, TypeDruidJDBC, TypeMySQL, TypePostgres, TypePresto, TypeRedshift, TypeSnowflake, TypeSparkSQL, TypeStarburst, TypeSQLServer, TypeSQLite:
		return true
	default:
		return false
	}
}

func (s *Service) provider(profile models.ConnectionProfile) (Provider, error) {
	if s == nil {
		return nil, fmt.Errorf("database service is not initialized")
	}
	provider, ok := s.providers[NormalizeType(profile.Type)]
	if !ok {
		return nil, fmt.Errorf("unsupported database type %q", profile.Type)
	}
	return provider, nil
}

func (s *Service) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	provider, err := s.provider(profile)
	if err != nil {
		return err
	}
	return provider.TestConnection(ctx, profile, password)
}

func (s *Service) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	provider, err := s.provider(profile)
	if err != nil {
		return models.QueryResult{}, err
	}
	return provider.Execute(ctx, profile, password, databaseName, queryText, limit, onConnectionID)
}

func (s *Service) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	provider, err := s.provider(profile)
	if err != nil {
		return err
	}
	return provider.KillQuery(ctx, profile, password, databaseName, connectionID)
}

func (s *Service) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	provider, err := s.provider(profile)
	if err != nil {
		return nil, err
	}
	return provider.ListDatabases(ctx, profile, password)
}

func (s *Service) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	provider, err := s.provider(profile)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	return provider.Schema(ctx, profile, password, databaseName)
}
