package migrations

import (
	"context"
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestAddJavRating(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE jav (id integer PRIMARY KEY, title text); INSERT INTO jav VALUES (1, 'Original')`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := 0; i < 2; i++ {
		if err := addJavRating(context.Background(), tx); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var title string
	var rating float64
	if err := db.QueryRow(`SELECT title, rating FROM jav WHERE id = 1`).Scan(&title, &rating); err != nil {
		t.Fatal(err)
	}
	if title != "Original" || rating != 0 {
		t.Fatalf("migrated row = %q, %v", title, rating)
	}
}
