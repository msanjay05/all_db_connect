package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"my-wails-app/internal/models"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open metadata database: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) migrate() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS connection_profiles (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			host TEXT NOT NULL,
			port INTEGER NOT NULL,
			username TEXT NOT NULL,
			database_name TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS query_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			connection_id TEXT NOT NULL,
			database_name TEXT NOT NULL DEFAULT '',
			sql_text TEXT NOT NULL,
			duration_ms INTEGER NOT NULL,
			row_count INTEGER NOT NULL,
			success INTEGER NOT NULL,
			error_text TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_query_history_created_at ON query_history(created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS schema_cache (
			connection_id TEXT PRIMARY KEY,
			database_name TEXT NOT NULL,
			schema_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	}

	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("migrate metadata database: %w", err)
		}
	}
	return nil
}

func (s *Store) UpsertProfile(input models.ConnectionProfileInput, now time.Time) (models.ConnectionProfile, error) {
	createdAt := now.UTC().Format(time.RFC3339)
	existing, err := s.GetProfile(input.ID)
	if err == nil {
		createdAt = existing.CreatedAt
	} else if err != sql.ErrNoRows {
		return models.ConnectionProfile{}, err
	}

	updatedAt := now.UTC().Format(time.RFC3339)
	_, err = s.db.Exec(
		`INSERT INTO connection_profiles (id, name, host, port, username, database_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			host = excluded.host,
			port = excluded.port,
			username = excluded.username,
			database_name = excluded.database_name,
			updated_at = excluded.updated_at`,
		input.ID,
		input.Name,
		input.Host,
		input.Port,
		input.Username,
		input.Database,
		createdAt,
		updatedAt,
	)
	if err != nil {
		return models.ConnectionProfile{}, fmt.Errorf("save profile: %w", err)
	}

	return models.ConnectionProfile{
		ID:        input.ID,
		Name:      input.Name,
		Host:      input.Host,
		Port:      input.Port,
		Username:  input.Username,
		Database:  input.Database,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	}, nil
}

func (s *Store) ListProfiles() ([]models.ConnectionProfile, error) {
	rows, err := s.db.Query(`SELECT id, name, host, port, username, database_name, created_at, updated_at FROM connection_profiles ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list profiles: %w", err)
	}
	defer rows.Close()

	var profiles []models.ConnectionProfile
	for rows.Next() {
		var profile models.ConnectionProfile
		if err := rows.Scan(&profile.ID, &profile.Name, &profile.Host, &profile.Port, &profile.Username, &profile.Database, &profile.CreatedAt, &profile.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan profile: %w", err)
		}
		profiles = append(profiles, profile)
	}
	return profiles, rows.Err()
}

func (s *Store) GetProfile(id string) (models.ConnectionProfile, error) {
	var profile models.ConnectionProfile
	err := s.db.QueryRow(
		`SELECT id, name, host, port, username, database_name, created_at, updated_at FROM connection_profiles WHERE id = ?`,
		id,
	).Scan(&profile.ID, &profile.Name, &profile.Host, &profile.Port, &profile.Username, &profile.Database, &profile.CreatedAt, &profile.UpdatedAt)
	if err != nil {
		return models.ConnectionProfile{}, err
	}
	return profile, nil
}

func (s *Store) DeleteProfile(id string) error {
	_, err := s.db.Exec(`DELETE FROM connection_profiles WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete profile: %w", err)
	}
	_, err = s.db.Exec(`DELETE FROM schema_cache WHERE connection_id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete schema cache: %w", err)
	}
	return nil
}

func (s *Store) SetDefaultDatabase(id string, database string) (models.ConnectionProfile, error) {
	updatedAt := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(`UPDATE connection_profiles SET database_name = ?, updated_at = ? WHERE id = ?`, database, updatedAt, id)
	if err != nil {
		return models.ConnectionProfile{}, fmt.Errorf("set default database: %w", err)
	}
	return s.GetProfile(id)
}

func (s *Store) AddHistory(entry models.QueryHistory) (int64, error) {
	result, err := s.db.Exec(
		`INSERT INTO query_history (connection_id, database_name, sql_text, duration_ms, row_count, success, error_text, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.ConnectionID,
		entry.Database,
		entry.SQL,
		entry.DurationMS,
		entry.RowCount,
		boolToInt(entry.Success),
		entry.Error,
		time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return 0, fmt.Errorf("add query history: %w", err)
	}
	return result.LastInsertId()
}

func (s *Store) ListHistory(limit int) ([]models.QueryHistory, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	rows, err := s.db.Query(
		`SELECT id, connection_id, database_name, sql_text, duration_ms, row_count, success, error_text, created_at
		 FROM query_history
		 ORDER BY datetime(created_at) DESC, id DESC
		 LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list query history: %w", err)
	}
	defer rows.Close()

	var history []models.QueryHistory
	for rows.Next() {
		var entry models.QueryHistory
		var success int
		if err := rows.Scan(&entry.ID, &entry.ConnectionID, &entry.Database, &entry.SQL, &entry.DurationMS, &entry.RowCount, &success, &entry.Error, &entry.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan query history: %w", err)
		}
		entry.Success = success == 1
		history = append(history, entry)
	}
	return history, rows.Err()
}

func (s *Store) SaveSchemaCache(connectionID string, schema models.SchemaInfo) error {
	data, err := json.Marshal(schema)
	if err != nil {
		return fmt.Errorf("marshal schema cache: %w", err)
	}
	_, err = s.db.Exec(
		`INSERT INTO schema_cache (connection_id, database_name, schema_json, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(connection_id) DO UPDATE SET
			database_name = excluded.database_name,
			schema_json = excluded.schema_json,
			updated_at = excluded.updated_at`,
		connectionID,
		schema.Database,
		string(data),
		time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return fmt.Errorf("save schema cache: %w", err)
	}
	return nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
