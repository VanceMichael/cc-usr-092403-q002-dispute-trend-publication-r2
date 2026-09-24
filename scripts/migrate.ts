import { openRawDatabase } from "../src/database.js";
import { runMigrations } from "../src/migrations.js";

const database = openRawDatabase();
runMigrations(database);
database.close();
