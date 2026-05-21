export namespace models {
	
	export class ColumnInfo {
	    name: string;
	    dataType: string;
	    columnType: string;
	    nullable: boolean;
	    key: string;
	    extra: string;
	    ordinalPosition: number;
	
	    static createFrom(source: any = {}) {
	        return new ColumnInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dataType = source["dataType"];
	        this.columnType = source["columnType"];
	        this.nullable = source["nullable"];
	        this.key = source["key"];
	        this.extra = source["extra"];
	        this.ordinalPosition = source["ordinalPosition"];
	    }
	}
	export class ConnectionProfile {
	    id: string;
	    name: string;
	    host: string;
	    port: number;
	    username: string;
	    database: string;
	    createdAt: string;
	    updatedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionProfile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.username = source["username"];
	        this.database = source["database"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	    }
	}
	export class ConnectionProfileInput {
	    id: string;
	    name: string;
	    host: string;
	    port: number;
	    username: string;
	    password: string;
	    database: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionProfileInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.username = source["username"];
	        this.password = source["password"];
	        this.database = source["database"];
	    }
	}
	export class ConnectionTestResult {
	    ok: boolean;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionTestResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.message = source["message"];
	    }
	}
	export class IndexInfo {
	    name: string;
	    unique: boolean;
	    type: string;
	    columns: string[];
	
	    static createFrom(source: any = {}) {
	        return new IndexInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.unique = source["unique"];
	        this.type = source["type"];
	        this.columns = source["columns"];
	    }
	}
	export class QueryColumn {
	    name: string;
	    database?: string;
	    table?: string;
	    type?: string;
	
	    static createFrom(source: any = {}) {
	        return new QueryColumn(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.database = source["database"];
	        this.table = source["table"];
	        this.type = source["type"];
	    }
	}
	export class QueryHistory {
	    id: number;
	    connectionId: string;
	    database: string;
	    sql: string;
	    durationMs: number;
	    rowCount: number;
	    success: boolean;
	    error?: string;
	    createdAt: string;
	
	    static createFrom(source: any = {}) {
	        return new QueryHistory(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	        this.sql = source["sql"];
	        this.durationMs = source["durationMs"];
	        this.rowCount = source["rowCount"];
	        this.success = source["success"];
	        this.error = source["error"];
	        this.createdAt = source["createdAt"];
	    }
	}
	export class QueryRequest {
	    connectionId: string;
	    database: string;
	    sql: string;
	    limit: number;
	
	    static createFrom(source: any = {}) {
	        return new QueryRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	        this.sql = source["sql"];
	        this.limit = source["limit"];
	    }
	}
	export class QueryResult {
	    columns: QueryColumn[];
	    rows: any[];
	    rowsAffected: number;
	    durationMs: number;
	    success: boolean;
	    error?: string;
	    historyId: number;
	
	    static createFrom(source: any = {}) {
	        return new QueryResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columns = this.convertValues(source["columns"], QueryColumn);
	        this.rows = source["rows"];
	        this.rowsAffected = source["rowsAffected"];
	        this.durationMs = source["durationMs"];
	        this.success = source["success"];
	        this.error = source["error"];
	        this.historyId = source["historyId"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TableInfo {
	    name: string;
	    type: string;
	    rowCount: number;
	    columns: ColumnInfo[];
	    indexes: IndexInfo[];
	
	    static createFrom(source: any = {}) {
	        return new TableInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.rowCount = source["rowCount"];
	        this.columns = this.convertValues(source["columns"], ColumnInfo);
	        this.indexes = this.convertValues(source["indexes"], IndexInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SchemaInfo {
	    database: string;
	    tables: TableInfo[];
	
	    static createFrom(source: any = {}) {
	        return new SchemaInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.database = source["database"];
	        this.tables = this.convertValues(source["tables"], TableInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SchemaRequest {
	    connectionId: string;
	    database: string;
	
	    static createFrom(source: any = {}) {
	        return new SchemaRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	    }
	}

}

