package db

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"my-wails-app/internal/models"
)

var limitClausePattern = regexp.MustCompile(`(?is)\blimit\s+\d+`)

func executeSQL(ctx context.Context, database *sql.DB, queryText string, limit int, connectionIDSQL string, onConnectionID func(int64)) (models.QueryResult, error) {
	queryText = strings.TrimSpace(queryText)
	if queryText == "" {
		return models.QueryResult{}, fmt.Errorf("query is empty")
	}

	queryCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	conn, err := database.Conn(queryCtx)
	if err != nil {
		return models.QueryResult{}, err
	}
	defer conn.Close()

	if connectionIDSQL != "" && onConnectionID != nil {
		var connectionID int64
		if err := conn.QueryRowContext(queryCtx, connectionIDSQL).Scan(&connectionID); err == nil {
			onConnectionID(connectionID)
		}
	}

	start := time.Now()
	if returnsRows(queryText) {
		queryText = applyDefaultLimit(queryText, limit)
		result, err := runSQLQuery(queryCtx, conn, queryText)
		result.DurationMS = time.Since(start).Milliseconds()
		return result, err
	}

	execResult, err := conn.ExecContext(queryCtx, queryText)
	duration := time.Since(start).Milliseconds()
	if err != nil {
		return models.QueryResult{DurationMS: duration, Success: false, Error: err.Error()}, err
	}

	rowsAffected, _ := execResult.RowsAffected()
	return models.QueryResult{
		Rows:         []map[string]interface{}{},
		Columns:      []models.QueryColumn{},
		RowsAffected: rowsAffected,
		DurationMS:   duration,
		Success:      true,
	}, nil
}

func applyDefaultLimit(sqlText string, limit int) string {
	if limit < 0 {
		return sqlText
	}
	if limit <= 0 {
		limit = 100
	}
	if !canApplyLimit(sqlText) || limitClausePattern.MatchString(sqlText) {
		return sqlText
	}
	return strings.TrimRight(strings.TrimSpace(sqlText), ";") + " LIMIT " + strconv.Itoa(limit)
}

func canApplyLimit(sqlText string) bool {
	fields := strings.Fields(strings.TrimSpace(strings.TrimLeft(sqlText, "(")))
	if len(fields) == 0 {
		return false
	}
	switch strings.ToUpper(fields[0]) {
	case "SELECT", "WITH":
		return true
	default:
		return false
	}
}

func runSQLQuery(ctx context.Context, conn *sql.Conn, sqlText string) (models.QueryResult, error) {
	rows, err := conn.QueryContext(ctx, sqlText)
	if err != nil {
		return models.QueryResult{Success: false, Error: err.Error()}, err
	}
	defer rows.Close()

	columnNames, err := rows.Columns()
	if err != nil {
		return models.QueryResult{Success: false, Error: err.Error()}, err
	}

	columnTypes, _ := rows.ColumnTypes()
	columns := make([]models.QueryColumn, len(columnNames))
	for i, name := range columnNames {
		columns[i] = models.QueryColumn{Name: name}
		if i < len(columnTypes) {
			columns[i].Type = columnTypes[i].DatabaseTypeName()
		}
	}

	var resultRows []map[string]interface{}
	for rows.Next() {
		values := make([]interface{}, len(columnNames))
		scanTargets := make([]interface{}, len(columnNames))
		for i := range values {
			scanTargets[i] = &values[i]
		}

		if err := rows.Scan(scanTargets...); err != nil {
			return models.QueryResult{Columns: columns, Rows: resultRows, Success: false, Error: err.Error()}, err
		}

		row := make(map[string]interface{}, len(columnNames))
		for i, name := range columnNames {
			row[name] = normalizeValue(values[i], columns[i].Type)
		}
		resultRows = append(resultRows, row)
	}
	if err := rows.Err(); err != nil {
		return models.QueryResult{Columns: columns, Rows: resultRows, Success: false, Error: err.Error()}, err
	}

	return models.QueryResult{
		Columns:      columns,
		Rows:         resultRows,
		RowsAffected: int64(len(resultRows)),
		Success:      true,
	}, nil
}

func normalizeValue(value interface{}, columnType string) interface{} {
	switch typed := value.(type) {
	case nil:
		return nil
	case []byte:
		if strings.EqualFold(columnType, "BIT") && len(typed) == 1 {
			if typed[0] == 0 {
				return 0
			}
			return 1
		}
		return string(typed)
	case time.Time:
		return typed.Format(time.RFC3339)
	default:
		return typed
	}
}

func returnsRows(sqlText string) bool {
	fields := strings.Fields(strings.TrimSpace(strings.TrimLeft(sqlText, "(")))
	if len(fields) == 0 {
		return false
	}

	switch strings.ToUpper(fields[0]) {
	case "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH", "PRAGMA":
		return true
	default:
		return false
	}
}

func requireDatabase(databaseName string) (string, error) {
	databaseName = strings.TrimSpace(databaseName)
	if databaseName == "" {
		return "", fmt.Errorf("select a database before running a query")
	}
	return databaseName, nil
}
