-- ============================================================
-- 回退玩家比赛记录脚本 v2（修正版）
-- 修复: 用 displayName 而非 accountName 匹配玩家
-- 用法: psql -h 127.0.0.1 -U postgres -d srvpro2_siro -f rollback-player-v2.sql
-- ============================================================

DO $$
DECLARE
    target_display_name TEXT := '稽查员';
    today_start TIMESTAMP := date_trunc('day', NOW());
    today_end TIMESTAMP := date_trunc('day', NOW()) + INTERVAL '1 day';

    match_rec RECORD;
    p RECORD;          -- 目标玩家在 duel_record_player 中的行
    opp RECORD;        -- 对手在 duel_record_player 中的行
    r_p RECORD;        -- 目标玩家的 player_rating（通过 displayName 匹配）
    r_o RECORD;        -- 对手的 player_rating（通过 displayName 匹配）

    result_type INT;   -- 0=稽查员赢, 1=稽查员输, -1=平局
    e_p FLOAT;
    e_o FLOAT;
    change_p INT;
    change_o INT;
    score_p FLOAT;
    score_o FLOAT;
    est_rp INT;
    est_ro INT;
    iter INT;

    match_count INT := 0;
    skipped_count INT := 0;
    affected_ratings TEXT[] := ARRAY[]::TEXT[];
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '============================================';
    RAISE NOTICE '  比赛记录回退脚本 v2（修正版）';
    RAISE NOTICE '  目标玩家显示名: %', target_display_name;
    RAISE NOTICE '  日期: %', today_start::DATE;
    RAISE NOTICE '  开始时间: %', NOW();
    RAISE NOTICE '============================================';
    RAISE NOTICE '';

    -- ★ 清理 v1 脚本的错误数据 ★
    -- 1. 删除 v1 创建的假 player_rating 记录
    DELETE FROM player_rating
    WHERE "accountName" IN ('稽查员', 'MANGO') AND wins = 0 AND losses = 0;

    -- 2. 检查真实用户状态
    FOR r_p IN
        SELECT pr."accountName", pr."displayName", pr.rating, pr.wins, pr.losses, pr.draws, pr."totalDuels"
        FROM player_rating pr
        WHERE pr."displayName" = target_display_name
           OR pr."accountName" = (SELECT DISTINCT drp."realName" FROM duel_record_player drp
                                  WHERE drp."realName" = target_display_name LIMIT 1)
    LOOP
        RAISE NOTICE '[恢复前] 稽查员 → accountName=%, rating=%, wins=%, losses=%, draws=%, total=%',
            r_p."accountName", r_p.rating, r_p.wins, r_p.losses, r_p.draws, r_p."totalDuels";
    END LOOP;

    -- 3. 恢复被 v1 软删除的今天比赛记录
    UPDATE duel_record SET "deleteTime" = NULL, "updateTime" = NOW()
    WHERE "createTime" >= today_start
      AND "createTime" < today_end
      AND "deleteTime" IS NOT NULL
      AND EXISTS (
          SELECT 1 FROM duel_record_player drp
          WHERE drp."duelRecordId" = duel_record.id
            AND drp."realName" = target_display_name
      );

    GET DIAGNOSTICS iter = ROW_COUNT;
    RAISE NOTICE '已恢复 % 条被 v1 误删的比赛记录', iter;
    RAISE NOTICE '';

    -- 遍历今天的所有比赛（按时间倒序，最新优先）
    FOR match_rec IN
        SELECT dr.id, dr.name, dr."winReason", dr."createTime", dr."hostInfo"
        FROM duel_record dr
        WHERE dr."createTime" >= today_start
          AND dr."createTime" < today_end
          AND dr."deleteTime" IS NULL
          AND EXISTS (
              SELECT 1 FROM duel_record_player drp
              WHERE drp."duelRecordId" = dr.id
                AND drp."realName" = target_display_name
                AND drp."deleteTime" IS NULL
          )
        ORDER BY dr."createTime" DESC
    LOOP
        match_count := match_count + 1;

        RAISE NOTICE '--- 比赛 #% ---', match_count;
        RAISE NOTICE '  ID: % | 房间: % | 时间: %',
            match_rec.id, match_rec.name, match_rec."createTime";

        -- 查找目标玩家（用 realName 匹配显示名）
        SELECT * INTO p FROM duel_record_player
        WHERE "duelRecordId" = match_rec.id
          AND "realName" = target_display_name
          AND "deleteTime" IS NULL
        LIMIT 1;

        IF p IS NULL THEN
            RAISE NOTICE '  → 跳过: 找不到玩家记录';
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        -- 查找对手（同一个 duel_record 中 pos IN (0,1) 且显示名不是稽查员）
        SELECT * INTO opp FROM duel_record_player
        WHERE "duelRecordId" = match_rec.id
          AND "realName" != target_display_name
          AND pos IN (0, 1)
          AND "deleteTime" IS NULL
        LIMIT 1;

        IF opp IS NULL THEN
            RAISE NOTICE '  → 跳过: 无对手 (可能是非标准模式)';
            skipped_count := skipped_count + 1;
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            CONTINUE;
        END IF;

        -- 检查 TAG 模式 (mode & 0x2)
        IF ((match_rec."hostInfo"->>'mode') IS NOT NULL
            AND (match_rec."hostInfo"->>'mode')::INT & 2 != 0) THEN
            RAISE NOTICE '  → 跳过 ELO回退: TAG模式 (只删除记录)';
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        -- 检查是否有 winReason (比赛已完成)
        IF match_rec."winReason" IS NULL THEN
            RAISE NOTICE '  → 跳过 ELO回退: 比赛未完成 (只删除记录)';
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        -- ★ 关键修正: 用 displayName 匹配 player_rating ★
        SELECT * INTO r_p FROM player_rating
        WHERE "displayName" = p."realName"
        ORDER BY "totalDuels" DESC NULLS LAST
        LIMIT 1;

        SELECT * INTO r_o FROM player_rating
        WHERE "displayName" = opp."realName"
        ORDER BY "totalDuels" DESC NULLS LAST
        LIMIT 1;

        -- 如果 displayName 匹配不到，尝试用 accountName 匹配 realName 做兜底
        IF r_p IS NULL THEN
            SELECT * INTO r_p FROM player_rating
            WHERE "accountName" = p."realName";
        END IF;

        IF r_o IS NULL THEN
            SELECT * INTO r_o FROM player_rating
            WHERE "accountName" = opp."realName";
        END IF;

        -- 如果还是找不到，跳过 ELO 回退
        IF r_p IS NULL THEN
            RAISE NOTICE '  → 警告: 找不到 % 的 player_rating（displayName=%），跳过ELO回退', target_display_name, p."realName";
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        IF r_o IS NULL THEN
            RAISE NOTICE '  → 警告: 找不到对手 % 的 player_rating（displayName=%），跳过ELO回退', opp."realName", opp."realName";
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        -- 确定比赛结果
        IF p.winner = true THEN
            result_type := 0;  -- 稽查员赢
            score_p := 1.0;
            score_o := 0.0;
            RAISE NOTICE '  结果: 稽查员 WIN vs % (账号: %)', opp."realName", r_o."accountName";
        ELSIF opp.winner = true THEN
            result_type := 1;  -- 稽查员输
            score_p := 0.0;
            score_o := 1.0;
            RAISE NOTICE '  结果: 稽查员 LOSE vs % (账号: %)', opp."realName", r_o."accountName";
        ELSE
            result_type := -1;  -- 平局
            score_p := 0.5;
            score_o := 0.5;
            RAISE NOTICE '  结果: 平局 vs % (账号: %)', opp."realName", r_o."accountName";
        END IF;

        RAISE NOTICE '  当前积分: [稽查员 %] %  | [对手 %] %',
            r_p."accountName", r_p.rating, r_o."accountName", r_o.rating;

        -- ============================================================
        -- ELO 回退: 迭代法从赛后积分反推赛前积分
        -- K=32, E=1/(1+10^(d/400)), 迭代5次收敛
        -- ============================================================
        est_rp := r_p.rating;
        est_ro := r_o.rating;

        FOR iter IN 1..5 LOOP
            e_p := 1.0 / (1.0 + POWER(10.0, (est_ro - est_rp)::FLOAT / 400.0));
            e_o := 1.0 - e_p;
            change_p := ROUND(32.0 * (score_p - e_p));
            change_o := ROUND(32.0 * (score_o - e_o));
            est_rp := r_p.rating - change_p;
            est_ro := r_o.rating - change_o;
        END LOOP;

        RAISE NOTICE '  ELO变化: [%] % | [%] %',
            r_p."accountName", change_p, r_o."accountName", change_o;

        -- 更新稽查员积分
        UPDATE player_rating SET
            rating = GREATEST(0, rating - change_p),
            wins = CASE WHEN result_type = 0 THEN GREATEST(0, wins - 1) ELSE wins END,
            losses = CASE WHEN result_type = 1 THEN GREATEST(0, losses - 1) ELSE losses END,
            draws = CASE WHEN result_type = -1 THEN GREATEST(0, draws - 1) ELSE draws END,
            "totalDuels" = GREATEST(0, "totalDuels" - 1),
            "winStreak" = CASE
                WHEN result_type = 0 THEN GREATEST(0, "winStreak" - 1)
                ELSE "winStreak"
            END,
            "lastDuelAt" = NULL
        WHERE "accountName" = r_p."accountName";

        RAISE NOTICE '  [% 稽查员] % → % (积分%+, 胜%→%, 负%→%, 总%→%)',
            r_p."accountName",
            r_p.rating, GREATEST(0, r_p.rating - change_p),
            -change_p,
            r_p.wins, GREATEST(0, r_p.wins - CASE WHEN result_type = 0 THEN 1 ELSE 0 END),
            r_p.losses, GREATEST(0, r_p.losses - CASE WHEN result_type = 1 THEN 1 ELSE 0 END),
            r_p."totalDuels", GREATEST(0, r_p."totalDuels" - 1);

        -- 更新对手积分
        UPDATE player_rating SET
            rating = GREATEST(0, rating - change_o),
            wins = CASE WHEN result_type = 1 THEN GREATEST(0, wins - 1) ELSE wins END,
            losses = CASE WHEN result_type = 0 THEN GREATEST(0, losses - 1) ELSE losses END,
            draws = CASE WHEN result_type = -1 THEN GREATEST(0, draws - 1) ELSE draws END,
            "totalDuels" = GREATEST(0, "totalDuels" - 1),
            "winStreak" = CASE
                WHEN result_type = 1 THEN GREATEST(0, "winStreak" - 1)
                ELSE "winStreak"
            END,
            "lastDuelAt" = NULL
        WHERE "accountName" = r_o."accountName";

        RAISE NOTICE '  [% %] % → % (积分%+, 胜%→%, 负%→%, 总%→%)',
            r_o."accountName", opp."realName",
            r_o.rating, GREATEST(0, r_o.rating - change_o),
            -change_o,
            r_o.wins, GREATEST(0, r_o.wins - CASE WHEN result_type = 1 THEN 1 ELSE 0 END),
            r_o.losses, GREATEST(0, r_o.losses - CASE WHEN result_type = 0 THEN 1 ELSE 0 END),
            r_o."totalDuels", GREATEST(0, r_o."totalDuels" - 1);

        -- 记录受影响玩家
        IF NOT (r_p."accountName" = ANY(affected_ratings)) THEN
            affected_ratings := array_append(affected_ratings, r_p."accountName");
        END IF;
        IF NOT (r_o."accountName" = ANY(affected_ratings)) THEN
            affected_ratings := array_append(affected_ratings, r_o."accountName");
        END IF;

        -- 软删除比赛记录
        UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
        RAISE NOTICE '  → 比赛记录已软删除';
        RAISE NOTICE '';

    END LOOP;

    RAISE NOTICE '';
    RAISE NOTICE '============================================';
    RAISE NOTICE '  执行结果';
    RAISE NOTICE '============================================';
    RAISE NOTICE '  处理比赛: % 场', match_count;
    RAISE NOTICE '  跳过: % 场', skipped_count;
    RAISE NOTICE '  受影响玩家账号 (%): %',
        array_length(affected_ratings, 1),
        array_to_string(affected_ratings, ', ');
    RAISE NOTICE '';
    RAISE NOTICE '  ⚠️ 胜场连胜(winStreak)可能不精确，请人工复查';
    RAISE NOTICE '  ⚠️ 最佳连胜(bestStreak)保持不变，可能虚高';
    RAISE NOTICE '============================================';
    RAISE NOTICE '';

    -- 显示受影响玩家的最终状态
    IF array_length(affected_ratings, 1) > 0 THEN
        RAISE NOTICE '受影响玩家最终状态:';
        RAISE NOTICE '-------------------------------------------';
        FOR i IN 1..array_length(affected_ratings, 1) LOOP
            FOR r_p IN
                SELECT "accountName", "displayName", rating, wins, losses, draws,
                       "totalDuels", "winStreak", "bestStreak"
                FROM player_rating
                WHERE "accountName" = affected_ratings[i]
            LOOP
                RAISE NOTICE '  % (%): 积分=%, 胜=%, 负=%, 平=%, 总场=%, 连胜=%, 最佳连胜=%',
                    r_p."accountName", r_p."displayName",
                    r_p.rating, r_p.wins, r_p.losses, r_p.draws,
                    r_p."totalDuels", r_p."winStreak", r_p."bestStreak";
            END LOOP;
        END LOOP;
        RAISE NOTICE '';
    END IF;

    -- 如果有 v1 脚本残留的假记录还在，再次清理
    DELETE FROM player_rating
    WHERE "accountName" = '稽查员' AND wins = 0 AND losses = 0;
    DELETE FROM player_rating
    WHERE "accountName" = 'MANGO' AND wins = 0 AND losses = 0;

EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '';
    RAISE NOTICE '============================================';
    RAISE NOTICE '  ❌ 执行失败!';
    RAISE NOTICE '  错误: %', SQLERRM;
    RAISE NOTICE '  详情: %', SQLSTATE;
    RAISE NOTICE '============================================';
    RAISE;
END $$;
