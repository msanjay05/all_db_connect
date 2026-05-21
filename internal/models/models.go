package models

type ConnectionProfile struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Username  string `json:"username"`
	Database  string `json:"database"`
	ReadOnly  bool   `json:"readOnly"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type ConnectionProfileInput struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database"`
	ReadOnly bool   `json:"readOnly"`
}

type ConnectionTestResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

type QueryRequest struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	SQL          string `json:"sql"`
	Limit        int    `json:"limit"`
}

type SchemaRequest struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
}

type QueryColumn struct {
	Name     string `json:"name"`
	Database string `json:"database,omitempty"`
	Table    string `json:"table,omitempty"`
	Type     string `json:"type,omitempty"`
}

type QueryResult struct {
	Columns      []QueryColumn            `json:"columns"`
	Rows         []map[string]interface{} `json:"rows"`
	RowsAffected int64                    `json:"rowsAffected"`
	DurationMS   int64                    `json:"durationMs"`
	Success      bool                     `json:"success"`
	Error        string                   `json:"error,omitempty"`
	HistoryID    int64                    `json:"historyId"`
}

type QueryHistory struct {
	ID           int64  `json:"id"`
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	SQL          string `json:"sql"`
	DurationMS   int64  `json:"durationMs"`
	RowCount     int64  `json:"rowCount"`
	Success      bool   `json:"success"`
	Error        string `json:"error,omitempty"`
	CreatedAt    string `json:"createdAt"`
}

type SchemaInfo struct {
	Database string      `json:"database"`
	Tables   []TableInfo `json:"tables"`
}

type TableInfo struct {
	Name     string       `json:"name"`
	Type     string       `json:"type"`
	RowCount int64        `json:"rowCount"`
	Columns  []ColumnInfo `json:"columns"`
	Indexes  []IndexInfo  `json:"indexes"`
}

type ColumnInfo struct {
	Name       string `json:"name"`
	DataType   string `json:"dataType"`
	ColumnType string `json:"columnType"`
	Nullable   bool   `json:"nullable"`
	Key        string `json:"key"`
	Extra      string `json:"extra"`
	OrdinalPos int    `json:"ordinalPosition"`
}

type IndexInfo struct {
	Name    string   `json:"name"`
	Unique  bool     `json:"unique"`
	Type    string   `json:"type"`
	Columns []string `json:"columns"`
}
