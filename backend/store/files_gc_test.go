package store

import (
	"context"
	"slices"
	"testing"
	"time"

	"fast_chat/model"
)

func TestDeleteOrphanFilesBefore(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	alice := createTestUser(t, s, "alice")
	bob := createTestUser(t, s, "bob")

	chat, err := s.CreateGroupChat(ctx, "g", alice.ID, []string{bob.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	message, _, err := s.AddMessage(ctx, chat.ID, "", alice.ID, "alice", "hi", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	old := time.Now().UTC().Add(-8 * 24 * time.Hour)

	save := func(hash, name string) *model.File {
		t.Helper()
		file, err := s.SaveFile(ctx, hash, "text/plain", 4, name, "2026/01/"+hash, alice.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.db.Model(&model.File{}).Where("id = ?", file.ID).
			Update("created_at", old).Error; err != nil {
			t.Fatal(err)
		}
		return file
	}

	attached := save("hash-attached", "attached.txt")
	if err := s.AddMessageFiles(ctx, message.ID, []string{attached.ID}); err != nil {
		t.Fatal(err)
	}

	avatar := save("hash-avatar", "avatar.png")
	if _, err := s.UpdateUserAvatar(ctx, alice.ID, avatar.ID); err != nil {
		t.Fatal(err)
	}

	chatAvatar := save("hash-chat-avatar", "chat.png")
	if _, err := s.UpdateChatAvatar(ctx, chat.ID, chatAvatar.ID); err != nil {
		t.Fatal(err)
	}

	orphan := save("hash-orphan", "orphan.txt")

	// A remote placeholder has no local bytes: deleting the row would lose
	// the only pointer to the peer's copy.
	if err := s.CreateRemoteFile(ctx, &model.File{
		ID: "remote-file", Hash: "hash-remote", MimeType: "text/plain", Size: 4,
		OriginalName: "remote.txt", UploadedBy: alice.ID, RemoteServer: "peer.test",
		CreatedAt: old,
	}); err != nil {
		t.Fatal(err)
	}

	recent, err := s.SaveFile(ctx, "hash-recent", "text/plain", 4, "recent.txt", "2026/01/recent", alice.ID)
	if err != nil {
		t.Fatal(err)
	}

	deleted, paths, err := s.DeleteOrphanFilesBefore(ctx, time.Now().UTC().Add(-7*24*time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}
	if !slices.Equal(paths, []string{orphan.StoragePath}) {
		t.Fatalf("paths = %v, want [%s]", paths, orphan.StoragePath)
	}

	for _, id := range []string{attached.ID, avatar.ID, chatAvatar.ID, "remote-file", recent.ID} {
		if _, err := s.GetFile(ctx, id); err != nil {
			t.Errorf("file %s was deleted: %v", id, err)
		}
	}
	if _, err := s.GetFile(ctx, orphan.ID); err == nil {
		t.Error("orphan file record still exists")
	}
}

func TestDeleteOrphanFilesBeforeKeepsSharedStorage(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	alice := createTestUser(t, s, "alice")
	old := time.Now().UTC().Add(-8 * 24 * time.Hour)

	// Two records may share one physical blob (the same hash uploaded under
	// two names). Only after both rows are gone may the bytes be removed.
	first, err := s.SaveFile(ctx, "hash-shared", "text/plain", 4, "a.txt", "2026/01/shared", alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.SaveFile(ctx, "hash-shared", "text/plain", 4, "b.txt", "2026/01/shared", alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{first.ID, second.ID} {
		if err := s.db.Model(&model.File{}).Where("id = ?", id).
			Update("created_at", old).Error; err != nil {
			t.Fatal(err)
		}
	}

	deleted, paths, err := s.DeleteOrphanFilesBefore(ctx, time.Now().UTC().Add(-7*24*time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 2 {
		t.Fatalf("deleted = %d, want 2", deleted)
	}
	if !slices.Equal(paths, []string{"2026/01/shared"}) {
		t.Fatalf("paths = %v, want the shared blob once", paths)
	}
}
