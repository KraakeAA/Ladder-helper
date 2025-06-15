// ladder_helper.js
// This is a new, separate file for your Greed's Ladder bot.

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.LADDER_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_ID = BOT_TOKEN.split(':')[0];

if (!BOT_TOKEN || !DATABASE_URL) {
    console.error("LADDER HELPER: CRITICAL: LADDER_BOT_TOKEN or DATABASE_URL is missing.");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_REJECT_UNAUTHORIZED === 'true' } : false,
});

// --- GAME CONSTANTS (Copied from main bot) ---
const LADDER_ROLL_COUNT = 5;
const LADDER_BUST_ON = 1;
const LADDER_PAYOUTS = [
    { min: 10, max: 14, multiplier: 1, label: "Nice Climb!" },
    { min: 15, max: 19, multiplier: 2, label: "High Rungs!" },
    { min: 20, max: 24, multiplier: 5, label: "Peak Performer!" },
    { min: 25, max: 29, multiplier: 10, label: "Sky High Roller!" },
    { min: 30, max: 30, multiplier: 25, label: "Ladder Legend!" }
];

// --- UTILITY FUNCTIONS ---
function escapeHTML(text) {
    if (text === null || typeof text === 'undefined') return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function safeSendMessage(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (e) {
        console.error(`[Ladder Helper] Failed to send message to ${chatId}: ${e.message}`);
        return null;
    }
}

function rollDie(sides = 6) {
    return Math.floor(Math.random() * sides) + 1;
}

function formatDiceRolls(rollsArray, diceEmoji = '🎲') {
    if (!Array.isArray(rollsArray) || rollsArray.length === 0) return '';
    return rollsArray.map(roll => `${diceEmoji} ${roll}`).join('  ');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


// --- DATABASE INTERACTION ---

async function finalizeAndRecordOutcome(sessionId, finalStatus, finalGameState = {}) {
    const logPrefix = `[LadderHelper_Finalize SID:${sessionId}]`;
    console.log(`${logPrefix} Finalizing game with status: ${finalStatus}`);
    try {
        await pool.query(
            "UPDATE ladder_sessions SET status = $1, game_state_json = $2, updated_at = NOW() WHERE session_id = $3",
            [finalStatus, JSON.stringify(finalGameState), sessionId]
        );
    } catch (e) {
        console.error(`${logPrefix} CRITICAL: Failed to write final outcome to DB: ${e.message}`);
    }
}

// --- CORE GAME LOGIC ---

/**
 * The entry point for the helper bot when it picks up a new game session.
 * Since Ladder is instant, this function handles the entire game flow.
 * @param {string} mainBotGameId - The unique game ID from the main bot.
 */
async function handleNewGameSession(mainBotGameId) {
    const logPrefix = `[LadderHelper_HandleNew GID:${mainBotGameId}]`;
    let client = null;
    let session = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const sessionRes = await client.query(
            "UPDATE ladder_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE main_bot_game_id = $2 AND status = 'pending_pickup' RETURNING *",
            [BOT_ID, mainBotGameId]
        );

        if (sessionRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return;
        }
        session = sessionRes.rows[0];
        await client.query('COMMIT');

        const gameState = session.game_state_json || {};
        const playerRefHTML = escapeHTML(gameState.initiatorName || `Player ${session.initiator_id}`);
        const betDisplay = `${(Number(session.bet_amount_lamports) / 1e9).toFixed(4)} SOL`;
        
        const rollingMessage = await safeSendMessage(session.chat_id, `🪜 <b>Greed's Ladder</b> for ${playerRefHTML}!\n\nWager: <b>${betDisplay}</b>\nRolling ${LADDER_ROLL_COUNT} dice...`, { parse_mode: 'HTML' });

        await sleep(2000); // Dramatic pause

        // --- Game Logic ---
        let rolls = [];
        let isBust = false;
        for (let i = 0; i < LADDER_ROLL_COUNT; i++) {
            const roll = rollDie();
            rolls.push(roll);
            if (roll === LADDER_BUST_ON) {
                isBust = true;
            }
        }
        
        const diceSum = rolls.reduce((sum, val) => sum + val, 0);
        gameState.rolls = rolls;
        gameState.sum = diceSum;

        let finalStatus = 'completed_loss';
        let payoutInfo = null;
        let resultText = "";

        if (isBust) {
            finalStatus = 'completed_bust';
            resultText = `💥 <b>CRASH! A ${LADDER_BUST_ON} appeared!</b> 💥\nYou tumbled off Greed's Ladder! Wager lost.`;
        } else {
            payoutInfo = LADDER_PAYOUTS.find(p => diceSum >= p.min && diceSum <= p.max);
            if (payoutInfo) {
                finalStatus = 'completed_win';
                gameState.payoutMultiplier = payoutInfo.multiplier;
                resultText = `🎉 <b>${escapeHTML(payoutInfo.label)}</b> 🎉\nYour payout will be processed by the main bot.`;
            } else {
                finalStatus = 'completed_loss_no_tier';
                resultText = `😐 A cautious climb, but your sum of <b>${diceSum}</b> was not high enough for a prize.`;
            }
        }
        
        // Construct final message
        let finalMessageHTML = `🏁 <b>Greed's Ladder Result</b> 🏁\n\nPlayer: ${playerRefHTML}\nRolls: ${formatDiceRolls(rolls)}\nSum: <b>${diceSum}</b>\n\n${resultText}`;
        
        if (rollingMessage?.message_id) {
            await bot.editMessageText(finalMessageHTML, { chat_id: session.chat_id, message_id: rollingMessage.message_id, parse_mode: 'HTML' }).catch(async () => {
                 await safeSendMessage(session.chat_id, finalMessageHTML, { parse_mode: 'HTML' });
            });
        } else {
            await safeSendMessage(session.chat_id, finalMessageHTML, { parse_mode: 'HTML' });
        }
        
        await finalizeAndRecordOutcome(session.session_id, finalStatus, gameState);

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error(`${logPrefix} Error handling new session: ${e.message}`);
        if(session) {
            await finalizeAndRecordOutcome(session.session_id, 'completed_error', {error: e.message});
        }
    } finally {
        if (client) client.release();
    }
}


// --- MAIN LISTENER ---

async function listenForNewGames() {
    const client = await pool.connect();
    client.on('notification', (msg) => {
        if (msg.channel === 'ladder_session_pickup') {
            try {
                const payload = JSON.parse(msg.payload);
                if (payload.main_bot_game_id) {
                    console.log(`[LadderHelper] Received pickup notification for ${payload.main_bot_game_id}`);
                    handleNewGameSession(payload.main_bot_game_id);
                }
            } catch (e) {
                console.error("[LadderHelper] Error parsing notification payload:", e);
            }
        }
    });
    await client.query('LISTEN ladder_session_pickup');
    const self = await bot.getMe();
    console.log(`✅ Ladder Helper Bot (@${self.username}) is online and listening for games...`);
}

listenForNewGames().catch(e => {
    console.error("FATAL: Failed to start Ladder Helper listener:", e);
    process.exit(1);
});

// This bot doesn't need a callback_query listener for game actions, as Ladder is non-interactive.
