-- A retrieval that a valet has taken ownership of, but not yet given to a
-- driver. Without this the queue can only say "requested" (nobody has it) or
-- "assigned" (a driver has it), and ownership has nowhere to show.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'accepted';
