-- sums on ledger by user
CREATE INDEX IF NOT EXISTS ix_ledger_user_id ON public.ledger(user_id);

-- deposits/withdrawals occasionally filtered by user
CREATE INDEX IF NOT EXISTS ix_deposits_user_id ON public.deposits(user_id);
CREATE INDEX IF NOT EXISTS ix_withdrawals_user_id ON public.withdrawals(user_id);

-- case-insensitive username lookup
CREATE INDEX IF NOT EXISTS ix_users_username_lower ON public.users (LOWER(username));
