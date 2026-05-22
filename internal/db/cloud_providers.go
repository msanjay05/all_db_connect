package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"cloud.google.com/go/bigquery"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/athena"
	athenatypes "github.com/aws/aws-sdk-go-v2/service/athena/types"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"

	"my-wails-app/internal/models"
)

type bigQueryProvider struct{}

func (p bigQueryProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	client, err := openBigQuery(ctx, profile)
	if err != nil {
		return err
	}
	defer client.Close()
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	it := client.Datasets(queryCtx)
	_, err = it.Next()
	if err == iterator.Done {
		return nil
	}
	return err
}

func (p bigQueryProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	client, err := openBigQuery(ctx, profile)
	if err != nil {
		return models.QueryResult{}, err
	}
	defer client.Close()
	queryCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	query := client.Query(applyDefaultLimit(queryText, limit))
	if profile.Region != "" {
		query.Location = profile.Region
	}
	if databaseName != "" {
		query.DefaultDatasetID = databaseName
	}
	start := time.Now()
	it, err := query.Read(queryCtx)
	duration := time.Since(start).Milliseconds()
	if err != nil {
		return models.QueryResult{DurationMS: duration, Success: false, Error: err.Error()}, err
	}
	columns := make([]models.QueryColumn, len(it.Schema))
	for index, field := range it.Schema {
		columns[index] = models.QueryColumn{Name: field.Name, Type: string(field.Type)}
	}
	var rows []map[string]interface{}
	for {
		values := make([]bigquery.Value, len(columns))
		if err := it.Next(&values); err == iterator.Done {
			break
		} else if err != nil {
			return models.QueryResult{Columns: columns, Rows: rows, DurationMS: duration, Success: false, Error: err.Error()}, err
		}
		row := map[string]interface{}{}
		for index, column := range columns {
			row[column.Name] = cleanBigQueryValue(values[index])
		}
		rows = append(rows, row)
	}
	return models.QueryResult{Columns: columns, Rows: rows, RowsAffected: int64(len(rows)), DurationMS: duration, Success: true}, nil
}

func (p bigQueryProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return fmt.Errorf("bigquery query cancellation is handled by context cancellation")
}

func (p bigQueryProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	client, err := openBigQuery(ctx, profile)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	it := client.Datasets(queryCtx)
	var datasets []string
	for {
		dataset, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		datasets = append(datasets, dataset.DatasetID)
	}
	return datasets, nil
}

func (p bigQueryProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	databaseName, err := requireDatabase(databaseName)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	client, err := openBigQuery(ctx, profile)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	defer client.Close()
	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	it := client.Dataset(databaseName).Tables(queryCtx)
	schema := models.SchemaInfo{Database: databaseName}
	for {
		table, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return models.SchemaInfo{}, err
		}
		meta, err := table.Metadata(queryCtx)
		if err != nil {
			return models.SchemaInfo{}, err
		}
		info := models.TableInfo{Name: table.TableID, Type: string(meta.Type), RowCount: int64(meta.NumRows)}
		for index, field := range meta.Schema {
			info.Columns = append(info.Columns, models.ColumnInfo{Name: field.Name, DataType: string(field.Type), ColumnType: string(field.Type), Nullable: !field.Required, OrdinalPos: index + 1})
		}
		schema.Tables = append(schema.Tables, info)
	}
	return schema, nil
}

type athenaProvider struct{}

func (p athenaProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	client, err := openAthena(ctx, profile)
	if err != nil {
		return err
	}
	_, err = client.ListDataCatalogs(ctx, &athena.ListDataCatalogsInput{})
	return err
}

func (p athenaProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	client, err := openAthena(ctx, profile)
	if err != nil {
		return models.QueryResult{}, err
	}
	params := extraParams(profile)
	output := stringParam(params, "outputLocation", "s3Output", "s3_output")
	if output == "" {
		return models.QueryResult{}, fmt.Errorf("athena outputLocation is required in extra params")
	}
	queryCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	input := &athena.StartQueryExecutionInput{
		QueryString: aws.String(applyDefaultLimit(queryText, limit)),
		ResultConfiguration: &athenatypes.ResultConfiguration{
			OutputLocation: aws.String(output),
		},
	}
	if databaseName != "" {
		input.QueryExecutionContext = &athenatypes.QueryExecutionContext{Database: aws.String(databaseName)}
	}
	if workgroup := stringParam(params, "workgroup", "workGroup"); workgroup != "" {
		input.WorkGroup = aws.String(workgroup)
	}
	start := time.Now()
	started, err := client.StartQueryExecution(queryCtx, input)
	if err != nil {
		duration := time.Since(start).Milliseconds()
		return models.QueryResult{DurationMS: duration, Success: false, Error: err.Error()}, err
	}
	queryID := aws.ToString(started.QueryExecutionId)
	for {
		status, err := client.GetQueryExecution(queryCtx, &athena.GetQueryExecutionInput{QueryExecutionId: aws.String(queryID)})
		if err != nil {
			duration := time.Since(start).Milliseconds()
			return models.QueryResult{DurationMS: duration, Success: false, Error: err.Error()}, err
		}
		state := status.QueryExecution.Status.State
		if state == athenatypes.QueryExecutionStateSucceeded {
			break
		}
		if state == athenatypes.QueryExecutionStateFailed || state == athenatypes.QueryExecutionStateCancelled {
			message := aws.ToString(status.QueryExecution.Status.StateChangeReason)
			duration := time.Since(start).Milliseconds()
			return models.QueryResult{DurationMS: duration, Success: false, Error: message}, fmt.Errorf("athena query %s: %s", state, message)
		}
		time.Sleep(500 * time.Millisecond)
	}
	result, err := athenaResults(queryCtx, client, queryID)
	result.DurationMS = time.Since(start).Milliseconds()
	return result, err
}

func (p athenaProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return fmt.Errorf("athena cancellation requires the query execution id from the active query")
}

func (p athenaProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	client, err := openAthena(ctx, profile)
	if err != nil {
		return nil, err
	}
	catalog := firstNonEmpty(profile.Account, "AwsDataCatalog")
	output, err := client.ListDatabases(ctx, &athena.ListDatabasesInput{CatalogName: aws.String(catalog)})
	if err != nil {
		return nil, err
	}
	var databases []string
	for _, database := range output.DatabaseList {
		databases = append(databases, aws.ToString(database.Name))
	}
	return databases, nil
}

func (p athenaProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	databaseName, err := requireDatabase(databaseName)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	client, err := openAthena(ctx, profile)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	catalog := firstNonEmpty(profile.Account, "AwsDataCatalog")
	output, err := client.ListTableMetadata(ctx, &athena.ListTableMetadataInput{CatalogName: aws.String(catalog), DatabaseName: aws.String(databaseName)})
	if err != nil {
		return models.SchemaInfo{}, err
	}
	schema := models.SchemaInfo{Database: databaseName}
	for _, table := range output.TableMetadataList {
		info := models.TableInfo{Name: aws.ToString(table.Name), Type: aws.ToString(table.TableType)}
		for index, column := range table.Columns {
			info.Columns = append(info.Columns, models.ColumnInfo{Name: aws.ToString(column.Name), DataType: aws.ToString(column.Type), ColumnType: aws.ToString(column.Type), Nullable: true, OrdinalPos: index + 1})
		}
		schema.Tables = append(schema.Tables, info)
	}
	return schema, nil
}

type databricksProvider struct{}
type sparkSQLProvider struct{}
type druidProvider struct{ avatica bool }

func (p databricksProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	_, err := databricksRequest(ctx, profile, password, http.MethodGet, "/api/2.0/sql/warehouses", nil)
	return err
}
func (p databricksProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	return executeDatabricksStatement(ctx, profile, password, databaseName, applyDefaultLimit(queryText, limit))
}
func (p databricksProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return fmt.Errorf("databricks query cancellation is handled by context cancellation")
}
func (p databricksProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	result, err := executeDatabricksStatement(ctx, profile, password, "", "SHOW CATALOGS")
	return firstColumnValues(result), err
}
func (p databricksProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	result, err := executeDatabricksStatement(ctx, profile, password, databaseName, "SHOW TABLES")
	if err != nil {
		return models.SchemaInfo{}, err
	}
	return schemaFromFirstColumn(databaseName, result), nil
}

func (p sparkSQLProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	_, err := executeSparkHTTP(ctx, profile, password, "SELECT 1")
	return err
}
func (p sparkSQLProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	return executeSparkHTTP(ctx, profile, password, applyDefaultLimit(queryText, limit))
}
func (p sparkSQLProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return fmt.Errorf("spark sql query cancellation is handled by context cancellation")
}
func (p sparkSQLProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	result, err := executeSparkHTTP(ctx, profile, password, "SHOW DATABASES")
	return firstColumnValues(result), err
}
func (p sparkSQLProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	result, err := executeSparkHTTP(ctx, profile, password, "SHOW TABLES")
	if err != nil {
		return models.SchemaInfo{}, err
	}
	return schemaFromFirstColumn(databaseName, result), nil
}

func (p druidProvider) TestConnection(ctx context.Context, profile models.ConnectionProfile, password string) error {
	_, err := executeDruidSQL(ctx, profile, password, "SELECT 1")
	return err
}
func (p druidProvider) Execute(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, queryText string, limit int, onConnectionID func(int64)) (models.QueryResult, error) {
	return executeDruidSQL(ctx, profile, password, applyDefaultLimit(queryText, limit))
}
func (p druidProvider) KillQuery(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, connectionID int64) error {
	return fmt.Errorf("druid query cancellation is handled by context cancellation")
}
func (p druidProvider) ListDatabases(ctx context.Context, profile models.ConnectionProfile, password string) ([]string, error) {
	return []string{"druid"}, nil
}
func (p druidProvider) Schema(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string) (models.SchemaInfo, error) {
	result, err := executeDruidSQL(ctx, profile, password, `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'druid'`)
	if err != nil {
		return models.SchemaInfo{}, err
	}
	return schemaFromFirstColumn(firstNonEmpty(databaseName, "druid"), result), nil
}

func openBigQuery(ctx context.Context, profile models.ConnectionProfile) (*bigquery.Client, error) {
	projectID := firstNonEmpty(profile.ProjectID, profile.Database)
	if projectID == "" {
		return nil, fmt.Errorf("bigquery project id is required")
	}
	var opts []option.ClientOption
	if profile.FilePath != "" {
		opts = append(opts, option.WithCredentialsFile(profile.FilePath))
	}
	return bigquery.NewClient(ctx, projectID, opts...)
}

func openAthena(ctx context.Context, profile models.ConnectionProfile) (*athena.Client, error) {
	region := firstNonEmpty(profile.Region, "us-east-1")
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}
	return athena.NewFromConfig(cfg), nil
}

func cleanBigQueryValue(value bigquery.Value) interface{} {
	switch typed := value.(type) {
	case time.Time:
		return typed.Format(time.RFC3339)
	case []byte:
		return string(typed)
	default:
		return typed
	}
}

func athenaResults(ctx context.Context, client *athena.Client, queryID string) (models.QueryResult, error) {
	paginator := athena.NewGetQueryResultsPaginator(client, &athena.GetQueryResultsInput{QueryExecutionId: aws.String(queryID)})
	var columns []models.QueryColumn
	var rows []map[string]interface{}
	firstPage := true
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return models.QueryResult{Success: false, Error: err.Error()}, err
		}
		if firstPage {
			for _, column := range page.ResultSet.ResultSetMetadata.ColumnInfo {
				columns = append(columns, models.QueryColumn{Name: aws.ToString(column.Name), Type: aws.ToString(column.Type)})
			}
		}
		for rowIndex, resultRow := range page.ResultSet.Rows {
			if firstPage && rowIndex == 0 {
				continue
			}
			row := map[string]interface{}{}
			for index, cell := range resultRow.Data {
				if index < len(columns) {
					row[columns[index].Name] = aws.ToString(cell.VarCharValue)
				}
			}
			rows = append(rows, row)
		}
		firstPage = false
	}
	return models.QueryResult{Columns: columns, Rows: rows, RowsAffected: int64(len(rows)), Success: true}, nil
}

func executeDatabricksStatement(ctx context.Context, profile models.ConnectionProfile, password string, databaseName string, statement string) (models.QueryResult, error) {
	params := extraParams(profile)
	warehouseID := firstNonEmpty(profile.Warehouse, params["warehouse_id"], params["warehouseId"])
	if warehouseID == "" {
		return models.QueryResult{}, fmt.Errorf("databricks warehouse id is required")
	}
	body := map[string]interface{}{
		"statement":    statement,
		"warehouse_id": warehouseID,
		"wait_timeout": "30s",
	}
	if databaseName != "" {
		body["catalog"] = databaseName
	}
	start := time.Now()
	raw, err := databricksRequest(ctx, profile, password, http.MethodPost, "/api/2.0/sql/statements", body)
	duration := time.Since(start).Milliseconds()
	if err != nil {
		return models.QueryResult{DurationMS: duration, Success: false, Error: err.Error()}, err
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return models.QueryResult{}, err
	}
	return rowsFromJSONResponse(decoded, duration), nil
}

func databricksRequest(ctx context.Context, profile models.ConnectionProfile, password string, method string, path string, body interface{}) ([]byte, error) {
	base := strings.TrimRight(firstNonEmpty(profile.ConnectionString, profile.Host), "/")
	if base == "" {
		return nil, fmt.Errorf("databricks host or connection string is required")
	}
	if !strings.HasPrefix(base, "http") {
		base = "https://" + base
	}
	return jsonHTTPRequest(ctx, method, base+path, password, body)
}

func executeDruidSQL(ctx context.Context, profile models.ConnectionProfile, password string, query string) (models.QueryResult, error) {
	base := strings.TrimRight(firstNonEmpty(profile.ConnectionString, profile.Host), "/")
	if base == "" {
		return models.QueryResult{}, fmt.Errorf("druid host or connection string is required")
	}
	if !strings.HasPrefix(base, "http") {
		base = "http://" + base
	}
	start := time.Now()
	raw, err := jsonHTTPRequest(ctx, http.MethodPost, base+"/druid/v2/sql", password, map[string]interface{}{"query": query})
	duration := time.Since(start).Milliseconds()
	if err != nil {
		return models.QueryResult{DurationMS: duration, Success: false, Error: err.Error()}, err
	}
	var rows []map[string]interface{}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return models.QueryResult{}, err
	}
	return models.QueryResult{Columns: columnsFromRows(rows), Rows: rows, RowsAffected: int64(len(rows)), DurationMS: duration, Success: true}, nil
}

func executeSparkHTTP(ctx context.Context, profile models.ConnectionProfile, password string, query string) (models.QueryResult, error) {
	base := strings.TrimRight(firstNonEmpty(profile.ConnectionString, profile.Host), "/")
	if base == "" {
		return models.QueryResult{}, fmt.Errorf("spark sql endpoint is required")
	}
	if !strings.HasPrefix(base, "http") {
		base = "http://" + base
	}
	endpoint := firstNonEmpty(stringParam(extraParams(profile), "endpoint", "path"), "/sql")
	start := time.Now()
	raw, err := jsonHTTPRequest(ctx, http.MethodPost, base+endpoint, password, map[string]interface{}{"query": query, "sql": query})
	duration := time.Since(start).Milliseconds()
	if err != nil {
		return models.QueryResult{DurationMS: duration, Success: false, Error: err.Error()}, err
	}
	var decoded interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return models.QueryResult{}, err
	}
	return rowsFromAnyJSON(decoded, duration), nil
}

func jsonHTTPRequest(ctx context.Context, method string, url string, bearerToken string, body interface{}) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(bearerToken) != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s returned %s: %s", url, resp.Status, string(data))
	}
	return data, nil
}

func rowsFromJSONResponse(decoded map[string]interface{}, duration int64) models.QueryResult {
	if result, ok := decoded["result"].(map[string]interface{}); ok {
		return rowsFromAnyJSON(result["data_array"], duration)
	}
	if data, ok := decoded["data_array"]; ok {
		return rowsFromAnyJSON(data, duration)
	}
	return rowsFromAnyJSON(decoded, duration)
}

func rowsFromAnyJSON(value interface{}, duration int64) models.QueryResult {
	var rows []map[string]interface{}
	switch typed := value.(type) {
	case []interface{}:
		for _, item := range typed {
			switch row := item.(type) {
			case map[string]interface{}:
				rows = append(rows, row)
			case []interface{}:
				next := map[string]interface{}{}
				for index, cell := range row {
					next[fmt.Sprintf("col_%d", index+1)] = cell
				}
				rows = append(rows, next)
			default:
				rows = append(rows, map[string]interface{}{"value": row})
			}
		}
	case map[string]interface{}:
		rows = append(rows, typed)
	default:
		rows = append(rows, map[string]interface{}{"value": typed})
	}
	return models.QueryResult{Columns: columnsFromRows(rows), Rows: rows, RowsAffected: int64(len(rows)), DurationMS: duration, Success: true}
}

func firstColumnValues(result models.QueryResult) []string {
	if len(result.Columns) == 0 {
		return nil
	}
	columnName := result.Columns[0].Name
	var values []string
	for _, row := range result.Rows {
		if value := strings.TrimSpace(fmt.Sprint(row[columnName])); value != "" {
			values = append(values, value)
		}
	}
	return values
}

func schemaFromFirstColumn(databaseName string, result models.QueryResult) models.SchemaInfo {
	schema := models.SchemaInfo{Database: databaseName}
	for _, name := range firstColumnValues(result) {
		schema.Tables = append(schema.Tables, models.TableInfo{Name: name, Type: "TABLE"})
	}
	return schema
}
