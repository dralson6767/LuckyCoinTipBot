-- ========= Snapshot of live TipBot data (READ-ONLY) =========

-- 0) Quick counts across core tables
SELECT
  (SELECT COUNT(*) FROM public.users)              AS users_count,
  (SELECT COUNT(*) FROM public.wallet_addresses)   AS wallet_addresses_count,
  (SELECT COUNT(*) FROM public.deposits)           AS deposits_count,
  (SELECT COUNT(*) FROM public.withdrawals)        AS withdrawals_count,
  (SELECT COUNT(*) FROM public.ledger)             AS ledger_count,
  (SELECT COUNT(*) FROM public.tips)               AS tips_count;

-- 1) Users table (tg_user_id is the canonical mapping)
SELECT id, tg_user_id, username
FROM public.users
ORDER BY id;

-- 2) Per-user summary (balance + deposit/withdraw + tips in/out)
WITH
bal AS (
  SELECT user_id, COALESCE(SUM(delta_lites),0) AS bal_lites
  FROM public.ledger GROUP BY user_id
),
dep AS (
  SELECT user_id,
         COUNT(*) dep_count,
         COALESCE(SUM(amount_lites),0) AS dep_sum_lites
  FROM public.deposits GROUP BY user_id
),
wd AS (
  SELECT user_id,
         COUNT(*) wd_count,
         COALESCE(SUM(amount_lites),0) AS wd_sum_lites
  FROM public.withdrawals GROUP BY user_id
),
tin AS (
  SELECT to_user_id AS user_id,
         COUNT(*) tip_in_count,
         COALESCE(SUM(amount_lites),0) AS tip_in_sum_lites
  FROM public.tips GROUP BY to_user_id
),
tout AS (
  SELECT from_user_id AS user_id,
         COUNT(*) tip_out_count,
         COALESCE(SUM(amount_lites),0) AS tip_out_sum_lites
  FROM public.tips GROUP BY from_user_id
)
SELECT
  u.id,
  u.tg_user_id,
  COALESCE(u.username,'') AS username,
  (bal.bal_lites/1e8)::numeric(30,8)        AS balance_lky,
  COALESCE(dep.dep_count,0)                 AS deposits,
  (COALESCE(dep.dep_sum_lites,0)/1e8)::numeric(30,8) AS deposits_lky,
  COALESCE(wd.wd_count,0)                   AS withdrawals,
  (COALESCE(wd.wd_sum_lites,0)/1e8)::numeric(30,8)   AS withdrawals_lky,
  COALESCE(tin.tip_in_count,0)              AS tips_in,
  (COALESCE(tin.tip_in_sum_lites,0)/1e8)::numeric(30,8)  AS tips_in_lky,
  COALESCE(tout.tip_out_count,0)            AS tips_out,
  (COALESCE(tout.tip_out_sum_lites,0)/1e8)::numeric(30,8) AS tips_out_lky
FROM public.users u
LEFT JOIN bal  ON bal.user_id  = u.id
LEFT JOIN dep  ON dep.user_id  = u.id
LEFT JOIN wd   ON wd.user_id   = u.id
LEFT JOIN tin  ON tin.user_id  = u.id
LEFT JOIN tout ON tout.user_id = u.id
ORDER BY u.id;

-- 3) Latest 50 tips with usernames
SELECT
  t.created_at,
  fu.tg_user_id AS from_tg,
  COALESCE(fu.username,'') AS from_username,
  tu.tg_user_id AS to_tg,
  COALESCE(tu.username,'') AS to_username,
  (t.amount_lites/1e8)::numeric(30,8) AS amount_lky
FROM public.tips t
JOIN public.users fu ON fu.id = t.from_user_id
JOIN public.users tu ON tu.id = t.to_user_id
ORDER BY t.created_at DESC
LIMIT 50;

-- 4) Ledger breakdown by reason
SELECT reason, COUNT(*) rows, (COALESCE(SUM(delta_lites),0)/1e8)::numeric(30,8) sum_lky
FROM public.ledger
GROUP BY reason
ORDER BY reason;
