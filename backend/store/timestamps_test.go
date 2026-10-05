package store

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/model"
)

// TestMessageTimestampsHaveNoColumnDefault guards the root cause of the
// invisible-federated-message bug: the `default:0` tag on model.Message's time
// fields made GORM emit the table creation instant as a literal column
// default, so any insert that omitted them stored midnight forever.
func TestMessageTimestampsHaveNoColumnDefault(t *testing.T) {
	s := newTestStore(t)

	defaults := columnDefaults(t, s.DB(), "messages")

	for _, column := range []string{"created_at", "updated_at"} {
		value, ok := defaults[column]
		if !ok {
			t.Errorf("column %s not found in messages", column)

			continue
		}

		if value != nil {
			t.Errorf("%s has column default %q, so an insert omitting it stores a frozen instant "+
				"and becomes invisible to sync", column, *value)
		}
	}
}

// columnDefaults reports the declared default of every column in a table, with
// a nil value for columns that have none. PRAGMA table_info is used instead of
// slicing the CREATE TABLE text so each default is attributed to its own
// column, whatever the declared type or default expression contains.
func columnDefaults(t *testing.T, db *gorm.DB, table string) map[string]*string {
	t.Helper()

	var info []struct {
		Name      string  `gorm:"column:name"`
		DfltValue *string `gorm:"column:dflt_value"`
	}

	if err := db.Raw("PRAGMA table_info(" + table + ")").Scan(&info).Error; err != nil {
		t.Fatal(err)
	}

	defaults := make(map[string]*string, len(info))
	for _, column := range info {
		defaults[column.Name] = column.DfltValue
	}

	return defaults
}

// newTimestampTestStore builds a store over the full schema, the same way
// InitDB does. The shared newTestStore omits push_subscriptions and
// message_read_statuses, which the timestamp migration walks.
func newTimestampTestStore(t *testing.T) *Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(
		&model.User{}, &model.Chat{}, &ChatMember{},
		&model.Message{}, &model.Thread{}, &model.File{},
		&model.MessageFile{}, &model.DeletedMessage{},
		&model.DeletedChat{}, &model.PushSubscription{},
		&model.MessageReadStatus{},
	); err != nil {
		t.Fatal(err)
	}

	return New(db)
}

// TestAddRawMessageStampsTimestamps covers the inbound federation path, which
// builds model.Message by hand instead of going through AddMessage.
//
// GORM's CreatedAt/UpdatedAt auto-tracking would cover the omitted fields on
// its own. A `default:` tag on them breaks that: the tag is resolved to a
// concrete time while the schema is parsed, and the create callback then
// substitutes that value into the INSERT instead of the tracked one — which is
// how these messages ended up stamped with a frozen instant and invisible to
// every sync delta. Stamping here keeps the rows correct even if that coupling
// is reintroduced; TestMessageTimestampsHaveNoColumnDefault guards the tag.
func TestAddRawMessageStampsTimestamps(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.AddRawMessage(ctx, &model.Message{
		ID:       "fed-1",
		ChatID:   chat.ID,
		FromID:   "bob:remote.test",
		FromNick: "bob",
		Text:     "hi from a peer",
	}); err != nil {
		t.Fatal(err)
	}

	var msg model.Message
	if err := s.DB().First(&msg, "id = ?", "fed-1").Error; err != nil {
		t.Fatal(err)
	}

	if msg.CreatedAt.IsZero() {
		t.Error("AddRawMessage left created_at unset")
	}

	if msg.UpdatedAt.IsZero() {
		t.Error("AddRawMessage left updated_at unset")
	}

	since := time.Now().UTC().Add(-time.Hour)

	changed := s.MessagesChangedSince(ctx, []string{chat.ID}, since)
	if len(changed) != 1 || changed[0].ID != "fed-1" {
		t.Fatalf("federated message missing from sync delta: got %d rows, want 1", len(changed))
	}
}

// TestAddRawMessageKeepsExplicitCreatedAt makes sure the new defaulting does
// not overwrite a timestamp the caller did supply.
func TestAddRawMessageKeepsExplicitCreatedAt(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	created := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	if err := s.AddRawMessage(ctx, &model.Message{
		ID:        "fed-2",
		ChatID:    chat.ID,
		FromID:    "bob:remote.test",
		FromNick:  "bob",
		Text:      "timestamped",
		CreatedAt: created,
	}); err != nil {
		t.Fatal(err)
	}

	var msg model.Message
	if err := s.DB().First(&msg, "id = ?", "fed-2").Error; err != nil {
		t.Fatal(err)
	}

	if !msg.CreatedAt.Equal(created) {
		t.Errorf("created_at = %s, want the caller-supplied %s", msg.CreatedAt, created)
	}

	if !msg.UpdatedAt.Equal(created) {
		t.Errorf("updated_at = %s, want it to follow created_at (%s)", msg.UpdatedAt, created)
	}
}

// TestPersistedTimestampsAreUTC pins the invariant the sync delta depends on.
//
// Timestamps are stored as text carrying a numeric offset, and the delta
// filters with a lexicographic `updated_at >= ?` against a UTC cursor. If a
// value carries any other offset, the comparison runs over wall-clock digits
// instead of over the instant.
func TestPersistedTimestampsAreUTC(t *testing.T) {
	s := newTimestampTestStore(t)
	ctx := context.Background()

	user := createTestUser(t, s, "alice")
	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	if _, _, err := s.AddMessage(ctx, chat.ID, "", user.ID, user.Nick, "hi", "", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	if err := s.SetKeyBackup(ctx, user.ID, "blob"); err != nil {
		t.Fatal(err)
	}

	if _, err := s.AddPushSubscription(ctx, user.ID, "https://fcm.googleapis.com/fcm/send/abc", "p256dh", "auth"); err != nil {
		t.Fatal(err)
	}

	if err := s.MarkMessagesDelivered(ctx, []string{mustMessageID(t, s, chat.ID)}, testBob); err != nil {
		t.Fatal(err)
	}

	for table, columns := range utcTimestampColumns {
		for _, column := range columns {
			assertColumnIsUTC(t, s.DB(), table, column)
		}
	}
}

// TestNormalizeTimestampsToUTCMigratesLegacyRows simulates a database written
// by an older build on a host west of UTC and asserts the delta recovers.
func TestNormalizeTimestampsToUTCMigratesLegacyRows(t *testing.T) {
	s := newTimestampTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	// A message stored in local time at 09:30-04:00, i.e. 13:30 UTC.
	legacy := time.Date(2026, 10, 2, 9, 30, 0, 0, time.FixedZone("EDT", -4*60*60))
	insertLegacyRow(t, s.DB(), chat.ID, "legacy", legacy)

	// 13:00 UTC, which is chronologically before the row above but has a
	// larger wall-clock reading than the row's stored "09:30:00-04:00".
	cutoff := time.Date(2026, 10, 2, 13, 0, 0, 0, time.UTC)

	if got := s.MessagesChangedSince(ctx, []string{chat.ID}, cutoff); len(got) != 0 {
		t.Fatalf("precondition: expected the offset-bearing row to be dropped before migration, got %d rows", len(got))
	}

	if err := normalizeTimestampsToUTC(s.DB()); err != nil {
		t.Fatal(err)
	}

	assertColumnIsUTC(t, s.DB(), "messages", "updated_at")

	// After migration the row must be found by the same query.
	if got := s.MessagesChangedSince(ctx, []string{chat.ID}, cutoff); len(got) != 1 || got[0].ID != "legacy" {
		t.Errorf("post-migration delta returned %d rows, want the legacy row", len(got))
	}

	// And a cursor after the row must still exclude it.
	later := time.Date(2026, 10, 2, 14, 0, 0, 0, time.UTC)
	if got := s.MessagesChangedSince(ctx, []string{chat.ID}, later); len(got) != 0 {
		t.Errorf("post-migration delta returned %d rows for a later cursor, want 0", len(got))
	}
}

// TestNormalizeTimestampsToUTCIsIdempotent guards against a migration that
// rewrites (and thereby keeps rewriting) rows on every boot.
func TestNormalizeTimestampsToUTCIsIdempotent(t *testing.T) {
	s := newTimestampTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	insertLegacyRow(t, s.DB(), chat.ID, "legacy", time.Now().In(time.FixedZone("JST", 9*60*60)))

	if _, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "fresh", "", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	if err := normalizeTimestampsToUTC(s.DB()); err != nil {
		t.Fatal(err)
	}

	before := snapshotColumn(t, s.DB(), "messages", "updated_at")
	if err := normalizeTimestampsToUTC(s.DB()); err != nil {
		t.Fatal(err)
	}

	if after := snapshotColumn(t, s.DB(), "messages", "updated_at"); after != before {
		t.Errorf("second migration pass changed data:\nfirst:  %s\nsecond: %s", before, after)
	}
}

// TestRepairFrozenUpdatedAt covers rows poisoned by the old frozen column
// default, whose stored updated_at predates their own created_at.
func TestRepairFrozenUpdatedAt(t *testing.T) {
	s := newTimestampTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	// Poisoned row: created_at 12:00, updated_at frozen to midnight.
	if err := s.DB().Exec(
		"INSERT INTO messages (id, chat_id, from_id, from_nick, text, encrypted, encrypted_payload, created_at, updated_at) "+
			"VALUES (?, ?, ?, ?, ?, 0, '', ?, ?)",
		"poisoned", chat.ID, testBob, "bob", "frozen",
		"2026-10-02 12:00:00+00:00", "2026-10-02 00:00:00+00:00",
	).Error; err != nil {
		t.Fatal(err)
	}

	// A healthy row that must not be touched.
	if _, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "healthy", "", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	since := time.Date(2026, 10, 2, 6, 0, 0, 0, time.UTC)
	if got := s.MessagesChangedSince(ctx, []string{chat.ID}, since); len(got) != 1 {
		t.Fatalf("precondition: poisoned row should be invisible before repair, got %d rows", len(got))
	}

	if err := repairFrozenUpdatedAt(s.DB()); err != nil {
		t.Fatal(err)
	}

	if got := s.MessagesChangedSince(ctx, []string{chat.ID}, since); len(got) != 2 {
		t.Errorf("after repair the delta returned %d rows, want 2", len(got))
	}

	var msg model.Message
	if err := s.DB().First(&msg, "id = ?", "poisoned").Error; err != nil {
		t.Fatal(err)
	}

	if !msg.UpdatedAt.Equal(msg.CreatedAt) {
		t.Errorf("updated_at = %s, want it repaired to created_at %s", msg.UpdatedAt, msg.CreatedAt)
	}
}

func assertColumnIsUTC(t *testing.T, db *gorm.DB, table, column string) {
	t.Helper()

	var offending []string

	rows, err := db.Raw(fmt.Sprintf(
		"SELECT CAST(%s.%s AS TEXT) FROM %s WHERE %s.%s IS NOT NULL AND substr(%s.%s, -6) <> '+00:00' LIMIT 5",
		table, column, table, table, column, table, column,
	)).Rows()
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			t.Fatal(err)
		}

		offending = append(offending, value)
	}

	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	if len(offending) > 0 {
		t.Errorf("%s.%s holds non-UTC timestamps %v; sync comparisons assume UTC", table, column, offending)
	}
}

func snapshotColumn(t *testing.T, db *gorm.DB, table, column string) string {
	t.Helper()

	var values []string
	if err := db.Raw(fmt.Sprintf("SELECT CAST(%s AS TEXT) FROM %s ORDER BY rowid", column, table)).
		Scan(&values).Error; err != nil {
		t.Fatal(err)
	}

	return strings.Join(values, "|")
}

func insertLegacyRow(t *testing.T, db *gorm.DB, chatID, id string, at time.Time) {
	t.Helper()

	if err := db.Exec(
		"INSERT INTO messages (id, chat_id, from_id, from_nick, text, encrypted, encrypted_payload, created_at, updated_at) "+
			"VALUES (?, ?, ?, ?, ?, 0, '', ?, ?)",
		id, chatID, testAlice, "alice", id, at.Format("2006-01-02 15:04:05.999999999-07:00"), at.Format("2006-01-02 15:04:05.999999999-07:00"),
	).Error; err != nil {
		t.Fatal(err)
	}
}

func mustMessageID(t *testing.T, s *Store, chatID string) string {
	t.Helper()

	msgs, _, _ := s.GetMessagesPaginated(context.Background(), chatID, 10, "")
	if len(msgs) == 0 {
		t.Fatal("expected at least one message in the chat")
	}

	return msgs[0].ID
}

// TestInitDBRunsTimestampMigrationsCleanly exercises the real startup path,
// which is the only place where the schema and the timestamp migrations meet.
//
// It asserts three things at once because InitDB is expensive: against a file
// database every DDL statement costs the pure-Go SQLite driver a few hundred
// milliseconds, so ~8s per call.
//
// A file DSN is required. With ":memory:" the four pooled connections would
// each get a private empty database, so a HasTable or count query can fail
// depending on which connection it lands on.
func TestInitDBRunsTimestampMigrationsCleanly(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "init.db")

	// InitDB logs at slog.Warn, which goes to stderr; capture the default
	// logger for the duration of the call.
	var logged bytes.Buffer

	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelWarn})))

	defer slog.SetDefault(previous)

	db, err := InitDB(dsn)
	if err != nil {
		t.Fatal(err)
	}

	// A table listed in utcTimestampColumns but not created above used to make
	// the pass fail with "no such table" on every boot.
	for table := range utcTimestampColumns {
		if !db.Migrator().HasTable(table) {
			t.Errorf("InitDB left %s unmigrated but the timestamp migration expects it", table)
		}
	}

	// Only the timestamp migrations are this test's responsibility. A warning
	// from some other migration must not be reported here, so match on the
	// messages InitDB emits for these two steps rather than on "any output".
	for _, marker := range []string{"normalize timestamps to UTC", "frozen message timestamps"} {
		if idx := strings.Index(logged.String(), marker); idx >= 0 {
			t.Errorf("timestamp migration reported a problem during InitDB:\n%s", logged.String()[idx:])
		}
	}

	// GORM fills in CreatedAt itself when a caller omits it, and its default
	// NowFunc is time.Now().Local(); a local value would be compared against a
	// UTC sync cursor by wall-clock digits.
	if err := db.Create(&model.Chat{ID: "c1", Type: "group"}).Error; err != nil {
		t.Fatal(err)
	}

	var chat model.Chat
	if err := db.First(&chat, "id = ?", "c1").Error; err != nil {
		t.Fatal(err)
	}

	if chat.CreatedAt.IsZero() {
		t.Error("CreatedAt was not auto-filled")
	}

	assertColumnIsUTC(t, db, "chats", "created_at")
}

// TestNormalizeTimestampsToUTCSkipsMissingTable verifies a schema change that
// drops or defers a table cannot disable the migration for every other column.
func TestNormalizeTimestampsToUTCSkipsMissingTable(t *testing.T) {
	s := newTestStore(t) // no push_subscriptions, no message_read_statuses

	if err := normalizeTimestampsToUTC(s.DB()); err != nil {
		t.Errorf("a missing table must be skipped, got: %v", err)
	}
}
