# All DB Connector

All DB Connector is a Wails + React desktop app for connecting to MySQL databases, browsing schema details, running queries, filtering results, exporting CSVs, and safely editing result rows.

## Features

- Save and manage multiple MySQL connection profiles.
- Mark a connection as read-only to allow only DQL statements such as `SELECT`, `SHOW`, `DESCRIBE`, and `EXPLAIN`.
- Browse databases, tables, columns, row counts, and indexes.
- Run SQL with multiple query tabs, history, formatting, explain, stop query, and CSV export.
- View paginated results with 50 rows shown by default.
- Filter result columns by text, number, date presets, date/time comparisons, and date ranges.
- Sort result columns with primary key columns first, then remaining columns alphabetically.
- Edit result cells for non-read-only connections and confirm generated `UPDATE ... WHERE <primary_key> = ...` queries before running them.

## Development

Run the app in live development mode:

```sh
wails dev
```

Run the frontend build:

```sh
npm --prefix frontend run build
```

Run Go tests:

```sh
go test ./...
```

## Building

Build a production desktop package:

```sh
wails build
```
