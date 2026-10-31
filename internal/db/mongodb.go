package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
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
	command, err := parseMongoCommand(queryText, limit)
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

var mongoShellRegex = regexp.MustCompile(`(?i)^\s*db(?:\.([A-Za-z0-9_$-]+)|\s*\.\s*getCollection\s*\(\s*['"]([^'"]+)['"]\s*\))\s*\.\s*([A-Za-z0-9_$]+)\s*\(([\s\S]*)\)\s*;?\s*$`)
var mongoSQLRegex = regexp.MustCompile(`(?i)^\s*SELECT\s+.*?\s+FROM\s+(?:[` + "`" + `"'` + `]?[A-Za-z0-9_$]+[` + "`" + `"'` + `]?\s*\.\s*)?([` + "`" + `"'` + `]?[A-Za-z0-9_$-]+[` + "`" + `"'` + `]?)(?:\s+WHERE\s+([\s\S]*?))?(?:\s+LIMIT\s+(\d+))?\s*;?\s*$`)

var objectIDRegex = regexp.MustCompile(`(?i)\b(?:new\s+)?ObjectId\s*\(\s*['"]([0-9a-fA-F]{24})['"]\s*\)`)
var isoDateRegex = regexp.MustCompile(`(?i)\b(?:new\s+)?ISODate\s*\(\s*['"]([^'"]+)['"]\s*\)`)
var numberLongRegex = regexp.MustCompile(`(?i)\bNumberLong\s*\(\s*['"]?(\d+)['"]?\s*\)`)
var numberIntRegex = regexp.MustCompile(`(?i)\bNumberInt\s*\(\s*['"]?(\d+)['"]?\s*\)`)
var trailingCommaRegex = regexp.MustCompile(`,\s*([\]}])`)
var unquotedKeyRegex = regexp.MustCompile(`([{,]\s*)([A-Za-z0-9_$]+)\s*:`)

func normalizeMongoJSON(input string) string {
	s := strings.TrimSpace(input)
	if s == "" {
		return "{}"
	}

	// 1. Replace ObjectId(...) -> {"$oid": "..."}
	s = objectIDRegex.ReplaceAllString(s, `{"$$oid": "$1"}`)

	// 2. Replace ISODate(...) -> {"$date": "$1"}
	s = isoDateRegex.ReplaceAllString(s, `{"$$date": "$1"}`)

	// 3. Replace NumberLong(...) -> {"$numberLong": "$1"}
	s = numberLongRegex.ReplaceAllString(s, `{"$$numberLong": "$1"}`)

	// 4. Replace NumberInt(...) -> $1
	s = numberIntRegex.ReplaceAllString(s, `$1`)

	// 5. Convert single quotes to double quotes
	s = convertSingleQuotesToDouble(s)

	// 6. Quote unquoted keys: { key: 1 } -> { "key": 1 }
	s = unquotedKeyRegex.ReplaceAllString(s, `$1"$2":`)

	// 7. Remove trailing commas: { a: 1, } -> { a: 1 }
	s = trailingCommaRegex.ReplaceAllString(s, `$1`)

	return s
}

func convertSingleQuotesToDouble(input string) string {
	var sb strings.Builder
	inSingleQuote := false
	inDoubleQuote := false
	escaped := false

	for _, r := range input {
		if escaped {
			if inSingleQuote && r == '\'' {
				sb.WriteRune('\'')
			} else if inSingleQuote && r == '"' {
				sb.WriteString(`\"`)
			} else {
				sb.WriteRune('\\')
				sb.WriteRune(r)
			}
			escaped = false
			continue
		}

		if r == '\\' {
			escaped = true
			continue
		}

		if r == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			sb.WriteRune(r)
			continue
		}

		if r == '\'' && !inDoubleQuote {
			inSingleQuote = !inSingleQuote
			sb.WriteRune('"')
			continue
		}

		if inSingleQuote && r == '"' {
			sb.WriteString(`\"`)
			continue
		}

		sb.WriteRune(r)
	}

	return sb.String()
}

func unmarshalMongoExtJSON(rawJSON string, target interface{}) error {
	normalized := normalizeMongoJSON(rawJSON)
	return bson.UnmarshalExtJSON([]byte(normalized), true, target)
}

func fixFilterID(doc bson.D) bson.D {
	result := make(bson.D, 0, len(doc))
	for _, elem := range doc {
		if elem.Key == "_id" {
			if strVal, ok := elem.Value.(string); ok && len(strVal) == 24 {
				if oid, err := primitive.ObjectIDFromHex(strVal); err == nil {
					// Match either ObjectID or String so it always works
					elem.Value = bson.D{
						{Key: "$in", Value: bson.A{oid, strVal}},
					}
				}
			}
		} else if nested, ok := elem.Value.(bson.D); ok {
			elem.Value = fixFilterID(nested)
		}
		result = append(result, elem)
	}
	return result
}

func parseMongoCommand(queryText string, defaultLimit int) (bson.D, error) {
	queryText = strings.TrimSpace(queryText)
	if queryText == "" {
		return nil, fmt.Errorf("query is empty")
	}

	// 1. Check if JSON command document: starts with {
	if strings.HasPrefix(queryText, "{") {
		var command bson.D
		if err := unmarshalMongoExtJSON(queryText, &command); err != nil {
			return nil, fmt.Errorf("mongodb queries must be JSON command documents: %w", err)
		}
		if defaultLimit > 0 && isFindCommandWithoutLimit(command) {
			command = append(command, bson.E{Key: "limit", Value: int64(defaultLimit)})
		}
		return command, nil
	}

	// 2. Check if MongoDB shell syntax: db.collection.method(...)
	if match := mongoShellRegex.FindStringSubmatch(queryText); len(match) > 4 {
		colName := match[1]
		if colName == "" {
			colName = match[2]
		}
		method := strings.ToLower(match[3])
		argsRaw := strings.TrimSpace(match[4])

		switch method {
		case "find", "findone":
			filter := bson.D{}
			var projection bson.D
			if argsRaw != "" {
				args := splitMongoArgs(argsRaw)
				if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
					if err := unmarshalMongoExtJSON(args[0], &filter); err != nil {
						return nil, fmt.Errorf("invalid find filter JSON: %w", err)
					}
					filter = fixFilterID(filter)
				}
				if len(args) > 1 && strings.TrimSpace(args[1]) != "" {
					if err := unmarshalMongoExtJSON(args[1], &projection); err != nil {
						return nil, fmt.Errorf("invalid find projection JSON: %w", err)
					}
				}
			}
			command := bson.D{
				{Key: "find", Value: colName},
				{Key: "filter", Value: filter},
			}
			if len(projection) > 0 {
				command = append(command, bson.E{Key: "projection", Value: projection})
			}
			if method == "findone" {
				command = append(command, bson.E{Key: "limit", Value: int64(1)})
			} else if defaultLimit > 0 {
				command = append(command, bson.E{Key: "limit", Value: int64(defaultLimit)})
			}
			return command, nil

		case "aggregate":
			pipeline := bson.A{}
			if argsRaw != "" {
				if err := unmarshalMongoExtJSON(argsRaw, &pipeline); err != nil {
					var singleStage bson.D
					if err2 := unmarshalMongoExtJSON(argsRaw, &singleStage); err2 == nil {
						pipeline = bson.A{singleStage}
					} else {
						return nil, fmt.Errorf("invalid aggregate pipeline JSON: %w", err)
					}
				}
			}
			command := bson.D{
				{Key: "aggregate", Value: colName},
				{Key: "pipeline", Value: pipeline},
				{Key: "cursor", Value: bson.D{}},
			}
			return command, nil

		case "count", "countdocuments":
			filter := bson.D{}
			if argsRaw != "" {
				args := splitMongoArgs(argsRaw)
				if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
					if err := unmarshalMongoExtJSON(args[0], &filter); err != nil {
						return nil, fmt.Errorf("invalid count filter JSON: %w", err)
					}
					filter = fixFilterID(filter)
				}
			}
			command := bson.D{
				{Key: "count", Value: colName},
				{Key: "query", Value: filter},
			}
			return command, nil

		case "distinct":
			args := splitMongoArgs(argsRaw)
			if len(args) == 0 || strings.TrimSpace(args[0]) == "" {
				return nil, fmt.Errorf("distinct requires a field name argument")
			}
			fieldName := strings.Trim(strings.TrimSpace(args[0]), `"'`)
			command := bson.D{
				{Key: "distinct", Value: colName},
				{Key: "key", Value: fieldName},
			}
			if len(args) > 1 && strings.TrimSpace(args[1]) != "" {
				var filter bson.D
				if err := unmarshalMongoExtJSON(args[1], &filter); err == nil {
					filter = fixFilterID(filter)
					command = append(command, bson.E{Key: "query", Value: filter})
				}
			}
			return command, nil

		case "drop":
			return bson.D{{Key: "drop", Value: colName}}, nil
		}
	}

	// 3. Check if SQL SELECT query: SELECT * FROM collection
	if match := mongoSQLRegex.FindStringSubmatch(queryText); len(match) > 1 {
		colName := strings.Trim(match[1], "`\"'")
		command := bson.D{
			{Key: "find", Value: colName},
			{Key: "filter", Value: bson.D{}},
		}
		limitVal := defaultLimit
		if len(match) > 3 && match[3] != "" {
			if l, err := strconv.Atoi(match[3]); err == nil && l > 0 {
				limitVal = l
			}
		}
		if limitVal > 0 {
			command = append(command, bson.E{Key: "limit", Value: int64(limitVal)})
		}
		return command, nil
	}

	var command bson.D
	if err := unmarshalMongoExtJSON(queryText, &command); err != nil {
		return nil, fmt.Errorf("mongodb queries must be shell expressions (e.g. db.collection.find()) or JSON command documents: %w", err)
	}
	return command, nil
}

func splitMongoArgs(argsStr string) []string {
	var args []string
	var current strings.Builder
	depthBrace := 0
	depthBracket := 0
	inQuote := false
	var quoteChar rune
	escaped := false

	for _, r := range argsStr {
		if escaped {
			current.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' {
			current.WriteRune(r)
			escaped = true
			continue
		}
		if inQuote {
			current.WriteRune(r)
			if r == quoteChar {
				inQuote = false
			}
			continue
		}
		if r == '"' || r == '\'' {
			inQuote = true
			quoteChar = r
			current.WriteRune(r)
			continue
		}
		if r == '{' {
			depthBrace++
		} else if r == '}' {
			depthBrace--
		} else if r == '[' {
			depthBracket++
		} else if r == ']' {
			depthBracket--
		}

		if r == ',' && depthBrace == 0 && depthBracket == 0 {
			trimmed := strings.TrimSpace(current.String())
			if trimmed != "" {
				args = append(args, trimmed)
			}
			current.Reset()
			continue
		}
		current.WriteRune(r)
	}

	trimmed := strings.TrimSpace(current.String())
	if trimmed != "" {
		args = append(args, trimmed)
	}
	return args
}

func isFindCommandWithoutLimit(command bson.D) bool {
	hasFind := false
	hasLimit := false
	for _, elem := range command {
		if elem.Key == "find" {
			hasFind = true
		}
		if elem.Key == "limit" {
			hasLimit = true
		}
	}
	return hasFind && !hasLimit
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
