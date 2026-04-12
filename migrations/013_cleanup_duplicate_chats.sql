-- Migration 012: Clean up duplicate direct chats
-- Keep only the newest direct chat for each pair of users

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
