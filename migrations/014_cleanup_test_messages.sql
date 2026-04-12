-- Migration 013: Clean up accumulated test messages
-- Remove messages containing test text from previous E2E runs

DELETE FROM messages 
WHERE encrypted_content IN ('Hello Alice!', 'Hi Admin!', 'test', '123', '1')
AND sender_id IN (
    SELECT id FROM users WHERE username IN ('admin', 'alice')
);

-- Also clean up any duplicate chats between admin and alice
-- Keep only the newest direct chat per user pair
DELETE FROM chats 
WHERE is_group = FALSE 
AND id NOT IN (
    SELECT DISTINCT ON (LEAST(p1.user_id, p2.user_id), GREATEST(p1.user_id, p2.user_id))
           c.id
    FROM chats c
    JOIN chat_participants p1 ON p1.chat_id = c.id
    JOIN chat_participants p2 ON p2.chat_id = c.id AND p1.user_id != p2.user_id
    WHERE c.is_group = FALSE
    ORDER BY LEAST(p1.user_id, p2.user_id), GREATEST(p1.user_id, p2.user_id), c.created_at DESC
);
