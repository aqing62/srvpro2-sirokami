-- ============================================================
-- 回退玩家比赛记录脚本 v3
-- 支持多个玩家，用 displayName 匹配 player_rating
-- 目标: 稽查员, MANGO, 墨
-- 用法: PGPASSWORD=jwyxym psql -h 127.0.0.1 -U postgres -d srvpro2_siro -f rollback-player-v3.sql
-- ============================================================

DO $$
DECLARE
    target_display_names TEXT[] := ARRAY['稽查员', 'MANGO', '墨'];
    today_start TIMESTAMP := date_trunc('day', NOW());
    today_end TIMESTAMP := date_trunc('day', NOW()) + INTERVAL '1 day';

    match_rec RECORD;
    p RECORD;
    opp RECORD;
    r_p RECORD;
    r_o RECORD;

    result_type INT;
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
    restored_count INT := 0;
    cleaned_count INT := 0;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '============================================';
    RAISE NOTICE '  比赛记录回退脚本 v3';
    RAISE NOTICE '  目标玩家: %', array_to_string(target_display_names, ', ');
    RAISE NOTICE '  日期: %', today_start::DATE;
    RAISE NOTICE '============================================';
    RAISE NOTICE '';

    -- ★★★ 第一步: 清理 v1 残留 ★★★

    -- 1. 删除 v1 假记录
    WITH deleted AS (
        DELETE FROM player_rating
        WHERE "accountName" IN ('稽查员', 'MANGO')
          AND wins = 0 AND losses = 0
        RETURNING "accountName"
    )
    SELECT COUNT(*) INTO cleaned_count FROM deleted;
    RAISE NOTICE '[清理] 删除 v1 假记录: % 条', cleaned_count;

    -- 2. 恢复被 v1 误删的比赛
    WITH restored AS (
        UPDATE duel_record SET "deleteTime" = NULL, "updateTime" = NOW()
        WHERE "createTime" >= today_start
          AND "createTime" < today_end
          AND "deleteTime" IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM duel_record_player drp
              WHERE drp."duelRecordId" = duel_record.id
                AND drp."realName" = ANY(target_display_names)
          )
        RETURNING id
    )
    SELECT COUNT(*) INTO restored_count FROM restored;
    RAISE NOTICE '[清理] 恢复 v1 误删比赛: % 条', restored_count;

    -- 3. 显示当前状态
    RAISE NOTICE '';
    RAISE NOTICE '[当前状态] 目标玩家 player_rating:';
    FOR r_p IN
        SELECT pr."accountName", pr."displayName", pr.rating, pr.wins, pr.losses, pr.draws, pr."totalDuels"
        FROM player_rating pr
        WHERE pr."displayName" = ANY(target_display_names)
        ORDER BY pr."displayName"
    LOOP
        RAISE NOTICE '  % (%): 积分=%, 胜=%, 负=%, 平=%, 总场=%',
            r_p."displayName", r_p."accountName",
            r_p.rating, r_p.wins, r_p.losses, r_p.draws, r_p."totalDuels";
    END LOOP;
    RAISE NOTICE '';

    -- ★★★ 第二步: 找今天所有相关比赛并按时间倒序回退 ★★★

    FOR match_rec IN
        -- 找出今天涉及任意目标玩家的比赛，去重用 MIN(id)
        SELECT DISTINCT ON (dr.id)
            dr.id, dr.name, dr."winReason", dr."createTime", dr."hostInfo"
        FROM duel_record dr
        WHERE dr."createTime" >= today_start
          AND dr."createTime" < today_end
          AND dr."deleteTime" IS NULL
          AND EXISTS (
              SELECT 1 FROM duel_record_player drp
              WHERE drp."duelRecordId" = dr.id
                AND drp."realName" = ANY(target_display_names)
                AND drp."deleteTime" IS NULL
          )
        ORDER BY dr.id, dr."createTime" DESC
    LOOP
        match_count := match_count + 1;

        RAISE NOTICE '--- 比赛 #% ---', match_count;
        RAISE NOTICE '  ID: % | 房间: % | 时间: %',
            match_rec.id, match_rec.name, match_rec."createTime";

        -- 找本场比赛中属于目标列表的玩家
        SELECT * INTO p FROM duel_record_player
        WHERE "duelRecordId" = match_rec.id
          AND "realName" = ANY(target_display_names)
          AND pos IN (0, 1)
          AND "deleteTime" IS NULL
        LIMIT 1;

        IF p IS NULL THEN
            RAISE NOTICE '  → 跳过: 目标玩家不在 pos 0/1';
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        -- 找对手（pos 0/1 中不是 p 的那个）
        SELECT * INTO opp FROM duel_record_player
        WHERE "duelRecordId" = match_rec.id
          AND id != p.id
          AND pos IN (0, 1)
          AND "deleteTime" IS NULL
        LIMIT 1;

        IF opp IS NULL THEN
            RAISE NOTICE '  → 跳过: 无对手';
            skipped_count := skipped_count + 1;
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            CONTINUE;
        END IF;

        -- 检查 TAG 模式
        IF ((match_rec."hostInfo"->>'mode') IS NOT NULL
            AND (match_rec."hostInfo"->>'mode')::INT & 2 != 0) THEN
            RAISE NOTICE '  → TAG模式, 只删除记录';
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        -- 比赛必须已完成
        IF match_rec."winReason" IS NULL THEN
            RAISE NOTICE '  → 比赛未完成, 只删除记录';
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        -- ★ 用 displayName 匹配 player_rating
        SELECT * INTO r_p FROM player_rating
        WHERE "displayName" = p."realName"
        LIMIT 1;

        SELECT * INTO r_o FROM player_rating
        WHERE "displayName" = opp."realName"
        LIMIT 1;

        -- 兜底：用 accountName
        IF r_p IS NULL THEN
            SELECT * INTO r_p FROM player_rating WHERE "accountName" = p."realName";
        END IF;
        IF r_o IS NULL THEN
            SELECT * INTO r_o FROM player_rating WHERE "accountName" = opp."realName";
        END IF;

        -- 找不到就跳过
        IF r_p IS NULL THEN
            RAISE NOTICE '  → 警告: 找不到 % 的 player_rating（displayName=%），跳过ELO', p."realName", p."realName";
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        IF r_o IS NULL THEN
            RAISE NOTICE '  → 警告: 找不到 % 的 player_rating（displayName=%），跳过ELO', opp."realName", opp."realName";
            UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
            skipped_count := skipped_count + 1;
            CONTINUE;
        END IF;

        -- 确定比赛结果
        IF p.winner = true THEN
            result_type := 0;
            score_p := 1.0; score_o := 0.0;
            RAISE NOTICE '  结果: % WIN vs %', p."realName", opp."realName";
        ELSIF opp.winner = true THEN
            result_type := 1;
            score_p := 0.0; score_o := 1.0;
            RAISE NOTICE '  结果: % LOSE vs %', p."realName", opp."realName";
        ELSE
            result_type := -1;
            score_p := 0.5; score_o := 0.5;
            RAISE NOTICE '  结果: % DRAW vs %', p."realName", opp."realName";
        END IF;

        RAISE NOTICE '  赛前积分: [%] %  | [%] %',
            r_p."accountName", r_p.rating, r_o."accountName", r_o.rating;

        -- ELO 反推（5次迭代）
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

        RAISE NOTICE '  ELO变化: % for [%], % for [%]', change_p, r_p."accountName", change_o, r_o."accountName";

        -- 更新 p 的积分
        UPDATE player_rating SET
            rating = GREATEST(0, rating - change_p),
            wins = CASE WHEN result_type = 0 THEN GREATEST(0, wins - 1) ELSE wins END,
            losses = CASE WHEN result_type = 1 THEN GREATEST(0, losses - 1) ELSE losses END,
            draws = CASE WHEN result_type = -1 THEN GREATEST(0, draws - 1) ELSE draws END,
            "totalDuels" = GREATEST(0, "totalDuels" - 1),
            "winStreak" = CASE WHEN result_type = 0 THEN GREATEST(0, "winStreak" - 1) ELSE "winStreak" END
        WHERE "accountName" = r_p."accountName";

        RAISE NOTICE '  [% %] %→% 胜%→% 负%→% 总%→%',
            r_p."accountName", r_p."displayName",
            r_p.rating, GREATEST(0, r_p.rating - change_p),
            r_p.wins, GREATEST(0, r_p.wins - CASE WHEN result_type = 0 THEN 1 ELSE 0 END),
            r_p.losses, GREATEST(0, r_p.losses - CASE WHEN result_type = 1 THEN 1 ELSE 0 END),
            r_p."totalDuels", GREATEST(0, r_p."totalDuels" - 1);

        -- 更新对手的积分
        UPDATE player_rating SET
            rating = GREATEST(0, rating - change_o),
            wins = CASE WHEN result_type = 1 THEN GREATEST(0, wins - 1) ELSE wins END,
            losses = CASE WHEN result_type = 0 THEN GREATEST(0, losses - 1) ELSE losses END,
            draws = CASE WHEN result_type = -1 THEN GREATEST(0, draws - 1) ELSE draws END,
            "totalDuels" = GREATEST(0, "totalDuels" - 1),
            "winStreak" = CASE WHEN result_type = 1 THEN GREATEST(0, "winStreak" - 1) ELSE "winStreak" END
        WHERE "accountName" = r_o."accountName";

        RAISE NOTICE '  [% %] %→% 胜%→% 负%→% 总%→%',
            r_o."accountName", r_o."displayName",
            r_o.rating, GREATEST(0, r_o.rating - change_o),
            r_o.wins, GREATEST(0, r_o.wins - CASE WHEN result_type = 1 THEN 1 ELSE 0 END),
            r_o.losses, GREATEST(0, r_o.losses - CASE WHEN result_type = 0 THEN 1 ELSE 0 END),
            r_o."totalDuels", GREATEST(0, r_o."totalDuels" - 1);

        -- 记录受影响账号
        IF NOT (r_p."accountName" = ANY(affected_ratings)) THEN
            affected_ratings := array_append(affected_ratings, r_p."accountName");
        END IF;
        IF NOT (r_o."accountName" = ANY(affected_ratings)) THEN
            affected_ratings := array_append(affected_ratings, r_o."accountName");
        END IF;

        -- 软删除比赛
        UPDATE duel_record SET "deleteTime" = NOW() WHERE id = match_rec.id;
        RAISE NOTICE '  → 比赛已软删除';
        RAISE NOTICE '';

    END LOOP;

    -- ★★★ 最终清理：删掉残留假记录 ★★★
    DELETE FROM player_rating WHERE "accountName" IN ('稽查员', 'MANGO') AND wins = 0 AND losses = 0;

    -- ★★★ 汇总 ★★★
    RAISE NOTICE '';
    RAISE NOTICE '============================================';
    RAISE NOTICE '  执行完成';
    RAISE NOTICE '============================================';
    RAISE NOTICE '  处理比赛: % 场', match_count;
    RAISE NOTICE '  跳过: % 场', skipped_count;
    RAISE NOTICE '  受影响账号 (%): %',
        array_length(affected_ratings, 1),
        array_to_string(affected_ratings, ', ');
    RAISE NOTICE '============================================';
    RAISE NOTICE '';
    RAISE NOTICE '受影响玩家最终状态:';
    RAISE NOTICE '-------------------------------------------';

    FOR i IN 1..array_length(affected_ratings, 1) LOOP
        FOR r_p IN
            SELECT * FROM player_rating WHERE "accountName" = affected_ratings[i]
        LOOP
            RAISE NOTICE '  % (%): 积分=%, 胜=%, 负=%, 平=%, 总场=%, 连胜=%',
                r_p."accountName", r_p."displayName",
                r_p.rating, r_p.wins, r_p.losses, r_p.draws,
                r_p."totalDuels", r_p."winStreak";
        END LOOP;
    END LOOP;
    RAISE NOTICE '';
    RAISE NOTICE '⚠️ 连胜(winStreak)可能需要人工复查';
    RAISE NOTICE '';

EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '';
    RAISE NOTICE '❌ 执行失败!';
    RAISE NOTICE '错误: %', SQLERRM;
    RAISE NOTICE '';
    RAISE;
END $$;
