package migrations

import (
	"context"
	"database/sql"

	"github.com/pressly/goose/v3"
)

func init() {
	goose.AddNamedMigrationContext("202610250001_add_jav_rating.go", addJavRating, irreversibleMigration)
}

func addJavRating(ctx context.Context, tx *sql.Tx) error {
	return addColumnIfMissing(ctx, tx, "jav", "rating", "real NOT NULL DEFAULT 0")
}
