package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"my-wails-app/internal/models"
)

type mongoProvider struct{}

func (p mongoProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	client, err := openMongo(ctx, profile, password)
	if err != nil {
		return err
	}
	defer client.Disconnect(ctx)

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return client.Ping(pingCtx, nil)
}

func (p mongoProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	databaseName, err := requireDatabase(databaseName)
	if err != nil {
		return models.QueryResult{}, err
	}
	command, err := parseMongoCommand(queryText)
	if err != nil {
		return models.QueryResult{}, err
	}

	client, err := openMongo(ctx, profile, password)
	if err != nil {
		return models.QueryResult{}, err
	}
	defer client.Disconnect(ctx)

	queryCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	start := time.Now()
	var response bson.M
	if err := client.Database(databaseName).RunCommand(queryCtx, command).Decode(&response); err != nil {
		duration := time.Since(start).Milliseconds()
		return models.QueryResult{DurationMS: duration, Success: false, Error: err.Error()}, err
	}

	result := mongoCommandResult(response)
	result.DurationMS = time.Since(start).Milliseconds()
	return result, nil
}

func (p mongoProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return fmt.Errorf("mongodb query cancellation is handled by context cancellation")
}

func (p mongoProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	client, err := openMongo(ctx, profile, password)
	if err != nil {
		return nil, err
	}
	defer client.Disconnect(ctx)

	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return client.ListDatabaseNames(queryCtx, bson.D{})
}

func (p mongoProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	databaseName, err := requireDatabase(databaseName)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	client, err := openMongo(ctx, profile, password)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	defer client.Disconnect(ctx)

	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	database := client.Database(databaseName)
	collections, err := database.ListCollectionNames(queryCtx, bson.D{})
	if err != nil {
		return models.SchemaInfo{}, fmt.Errorf("list collections: %w", err)
	}
	sort.Strings(collections)

	schema := models.SchemaInfo{Database: databaseName}
	for _, collectionName := range collections {
		table := models.TableInfo{Name: collectionName, Type: "COLLECTION"}
		count, _ := database.Collection(collectionName).CountDocuments(queryCtx, bson.D{})
		table.RowCount = count

		var sample bson.M
		if err := database.Collection(collectionName).FindOne(queryCtx, bson.D{}).Decode(&sample); err == nil {
			names := make([]string, 0, len(sample))
			for name := range sample {
				names = append(names, name)
			}
			sort.Strings(names)
			for index, name := range names {
				column := models.ColumnInfo{
					Name:       name,
					DataType:   mongoValueType(sample[name]),
					ColumnType: mongoValueType(sample[name]),
					Nullable:   true,
					OrdinalPos: index + 1,
				}
				if name == "_id" {
					column.Key = "PRI"
				}
				table.Columns = append(table.Columns, column)
			}
		}

		table.Indexes = append(table.Indexes, models.IndexInfo{Name: "_id_", Unique: true, Type: "BTREE", Columns: []string{"_id"}})
		schema.Tables = append(schema.Tables, table)
	}
	return schema, nil
}

func openMongo(ctx context.Context, profile models.ConnectionProfile, password string) (*mongo.Client, error) {
	uri := strings.TrimSpace(profile.ConnectionString)
	if uri == "" {
		port := profile.Port
		if port == 0 {
			port = 27017
		}
		host := strings.TrimSpace(profile.Host)
		if host == "" {
			host = "localhost"
		}
		uri = "mongodb://" + host + ":" + strconv.Itoa(port)
	}

	clientOptions := options.Client().ApplyURI(uri)
	if strings.TrimSpace(profile.Username) != "" {
		clientOptions.SetAuth(options.Credential{
			Username: profile.Username,
			Password: password,
		})
	}

	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	client, err := mongo.Connect(connectCtx, clientOptions)
	if err != nil {
		return nil, fmt.Errorf("open mongodb connection: %w", err)
	}
	return client, nil
}

func parseMongoCommand(queryText string) (bson.D, error) {
	queryText = strings.TrimSpace(queryText)
	if queryText == "" {
		return nil, fmt.Errorf("query is empty")
	}
	var command bson.D
	if err := bson.UnmarshalExtJSON([]byte(queryText), true, &command); err != nil {
		return nil, fmt.Errorf("mongodb queries must be JSON command documents: %w", err)
	}
	return command, nil
}

func mongoCommandResult(response bson.M) models.QueryResult {
	rows := mongoRowsFromResponse(response)
	return models.QueryResult{
		Columns:      columnsFromRows(rows),
		Rows:         rows,
		RowsAffected: int64(len(rows)),
		Success:      true,
	}
}

func mongoRowsFromResponse(response bson.M) []map[string]interface{} {
	if cursor, ok := response["cursor"].(bson.M); ok {
		return mongoArrayRows(cursor["firstBatch"])
	}
	if cursor, ok := response["cursor"].(map[string]interface{}); ok {
		return mongoArrayRows(cursor["firstBatch"])
	}
	if value, ok := response["n"]; ok {
		return []map[string]interface{}{{"n": cleanMongoValue(value)}}
	}
	if value, ok := response["values"]; ok {
		return mongoArrayRows(value)
	}
	return []map[string]interface{}{cleanMongoDocument(response)}
}

func mongoArrayRows(value interface{}) []map[string]interface{} {
	var rows []map[string]interface{}
	switch typed := value.(type) {
	case primitive.A:
		for _, item := range typed {
			rows = append(rows, cleanMongoDocumentValue(item))
		}
	case []interface{}:
		for _, item := range typed {
			rows = append(rows, cleanMongoDocumentValue(item))
		}
	}
	return rows
}

func cleanMongoDocumentValue(value interface{}) map[string]interface{} {
	if doc, ok := value.(bson.M); ok {
		return cleanMongoDocument(doc)
	}
	if doc, ok := value.(map[string]interface{}); ok {
		return cleanMongoDocument(doc)
	}
	return map[string]interface{}{"value": cleanMongoValue(value)}
}

func cleanMongoDocument(doc map[string]interface{}) map[string]interface{} {
	row := make(map[string]interface{}, len(doc))
	for key, value := range doc {
		row[key] = cleanMongoValue(value)
	}
	return row
}

func cleanMongoValue(value interface{}) interface{} {
	if value == nil {
		return nil
	}
	jsonBytes, err := json.Marshal(value)
	if err == nil {
		var decoded interface{}
		if err := json.Unmarshal(jsonBytes, &decoded); err == nil {
			return decoded
		}
	}
	return fmt.Sprint(value)
}

func columnsFromRows(rows []map[string]interface{}) []models.QueryColumn {
	seen := map[string]bool{}
	var names []string
	for _, row := range rows {
		for name := range row {
			if !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
		}
	}
	sort.Strings(names)
	columns := make([]models.QueryColumn, len(names))
	for index, name := range names {
		var sample interface{}
		for _, row := range rows {
			if value, ok := row[name]; ok {
				sample = value
				break
			}
		}
		columns[index] = models.QueryColumn{Name: name, Type: mongoValueType(sample)}
	}
	return columns
}

func mongoValueType(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case primitive.ObjectID:
		return "objectId"
	case primitive.DateTime:
		return "date"
	case primitive.A, []interface{}:
		return "array"
	case bson.M, map[string]interface{}:
		return "object"
	default:
		return fmt.Sprintf("%T", typed)
	}
}

func redactMongoURI(uri string) string {
	parsed, err := url.Parse(uri)
	if err != nil || parsed.User == nil {
		return uri
	}
	parsed.User = url.User(parsed.User.Username())
	return parsed.String()
}
