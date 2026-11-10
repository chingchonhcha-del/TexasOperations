require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
    Client,
    GatewayIntentBits,
    Partials,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    SlashCommandBuilder,
    REST,
    Routes,
    AttachmentBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder
} = require("discord.js");

const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType
} = require("@discordjs/voice");

const execFileAsync = promisify(execFile);

/* =========================================================
   FFMPEG
========================================================= */

try {
    const ffmpegPath = require("ffmpeg-static");

    if (ffmpegPath) {
        process.env.PATH =
            `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH || ""}`;
    }
} catch (error) {
    console.warn("Could not load ffmpeg-static:", error.message);
}

/* =========================================================
   CONFIGURATION
========================================================= */

const e = process.env;
const BRAND = "Texas Operations";

const cfg = {
    token: e.DISCORD_TOKEN,
    clientId: e.CLIENT_ID,
    guildId: e.GUILD_ID,
    prefix: e.PREFIX || "!",

    welcomeChannel: e.WELCOME_CHANNEL_ID,
    welcomeEmoji: e.WELCOME_EMOJI || "",

    logChannel: e.LOG_CHANNEL_ID,
    staffLogChannel: e.STAFF_LOG_CHANNEL_ID,

    staffRole: e.STAFF_ROLE_ID,
    adminRole: e.ADMIN_ROLE_ID,

    supportRole: e.TICKET_SUPPORT_ROLE_ID,
    iaRole: e.INTERNAL_AFFAIRS_ROLE_ID,
    managementRole: e.MANAGEMENT_ROLE_ID,

    generalCategory: e.GENERAL_SUPPORT_CATEGORY_ID || e.TICKET_CATEGORY_ID,
    reportCategory: e.REPORT_TICKETS_CATEGORY_ID,
    managementCategory: e.MANAGEMENT_SUPPORT_CATEGORY_ID,
    iaCategory: e.INTERNAL_AFFAIRS_CATEGORY_ID,

    panelChannel: e.TICKET_PANEL_CHANNEL_ID,
    feedbackChannel: e.FEEDBACK_CHANNEL_ID,
    applicationChannel: e.APPLICATION_RESULTS_CHANNEL_ID,

    voiceChannel: e.VOICE_CHANNEL_ID,
    sessionChannel: e.SESSION_VOTE_CHANNEL_ID,

    serverName: e.SESSION_SERVER_NAME || BRAND,
    serverCode: e.SESSION_SERVER_CODE || "CSRPVOS",
    gameUrl: e.SESSION_GAME_URL || "",
    requiredVotes: Math.max(1, Number(e.SESSION_REQUIRED_VOTES || 5)),

    port: Number(e.PORT || 3000),

    // Optional Components V2 banner images. Feature banners fall back to DEFAULT_BANNER_URL.
    defaultBanner: e.DEFAULT_BANNER_URL || "",
    sessionBanner: e.SESSION_BANNER_URL || "",
    priorityBanner: e.PRIORITY_BANNER_URL || "",
    ticketBanner: e.TICKET_BANNER_URL || "",
    staffBanner: e.STAFF_BANNER_URL || "",
    moderationBanner: e.MODERATION_BANNER_URL || "",
    automatedBanner: e.AUTOMATED_BANNER_URL || ""
};

if (!cfg.token || !cfg.clientId) {
    console.error("ERROR: Add DISCORD_TOKEN and CLIENT_ID to your .env file.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.User
    ]
});

const tickets = new Map();
const claims = new Map();
const priorities = new Map();
const warnings = new Map();
const sessionVotes = new Map();
const activeSessions = new Map();

const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;

/* =========================================================
   AUDIO PLAYER AND WINDOWS SPEECH
========================================================= */

const speechPlayer = createAudioPlayer({
    behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
    }
});

const speechQueue = [];
let speechQueueRunning = false;
let voiceJoinInProgress = false;

speechPlayer.on("error", error => {
    console.error("[VOICE] Audio player error:", error.message);
});

speechPlayer.on(AudioPlayerStatus.Playing, () => {
    console.log("[VOICE] Announcement is now playing.");
});

speechPlayer.on(AudioPlayerStatus.Idle, () => {
    console.log("[VOICE] Announcement playback finished.");
});

async function generateWindowsSpeech(text) {
    const spokenText = String(text || "").trim();

    if (!spokenText) {
        throw new Error("The speech announcement is empty.");
    }

    if (process.platform !== "win32") {
        throw new Error(
            "Windows built-in speech requires the bot to run on Windows."
        );
    }

    const audioPath = path.join(
        os.tmpdir(),
        `texas-speech-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
    );

    const encodedText = Buffer.from(spokenText, "utf8").toString("base64");
    const encodedPath = Buffer.from(audioPath, "utf8").toString("base64");

    const powershellScript = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$text = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String("${encodedText}")
)

$outputPath = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String("${encodedPath}")
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

try {
    $synth.Rate = 0
    $synth.Volume = 100

    $installedVoices = @(
        $synth.GetInstalledVoices() |
        Where-Object { $_.Enabled }
    )

    $preferredNames = @(
        "Microsoft David Desktop",
        "Microsoft Mark",
        "Microsoft Guy Online",
        "Microsoft Ryan Online"
    )

    $selectedVoice = $null

    foreach ($preferredName in $preferredNames) {
        $match = $installedVoices |
            Where-Object { $_.VoiceInfo.Name -eq $preferredName } |
            Select-Object -First 1

        if ($match) {
            $selectedVoice = $match
            break
        }
    }

    if (-not $selectedVoice) {
        $selectedVoice = $installedVoices |
            Where-Object { $_.VoiceInfo.Gender.ToString() -eq "Male" } |
            Select-Object -First 1
    }

    if ($selectedVoice) {
        $synth.SelectVoice($selectedVoice.VoiceInfo.Name)
        Write-Output ("Selected voice: " + $selectedVoice.VoiceInfo.Name)
    }
    elseif ($installedVoices.Count -gt 0) {
        $synth.SelectVoice($installedVoices[0].VoiceInfo.Name)
        Write-Warning "No identifiable male voice was found; using the first installed voice."
    }
    else {
        throw "No enabled Windows speech voices are installed."
    }

    $synth.SetOutputToWaveFile($outputPath)
    $synth.Speak($text)
}
finally {
    $synth.Dispose()
}
`;

    const encodedScript = Buffer
        .from(powershellScript, "utf16le")
        .toString("base64");

    console.log("[SPEECH] Generating Windows speech...");

    try {
        const result = await execFileAsync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                encodedScript
            ],
            {
                windowsHide: true,
                timeout: 60000,
                maxBuffer: 1024 * 1024
            }
        );

        if (result.stdout?.trim()) {
            console.log("[SPEECH]", result.stdout.trim());
        }

        if (result.stderr?.trim()) {
            console.warn("[SPEECH]", result.stderr.trim());
        }

        const file = await fs.stat(audioPath);

        if (!file.size) {
            throw new Error("Windows generated an empty audio file.");
        }

        return audioPath;
    } catch (error) {
        await fs.unlink(audioPath).catch(() => {});
        throw new Error(`Windows speech generation failed: ${error.message}`);
    }
}

function waitForPlayerIdle(player, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            clearTimeout(timer);
            player.off(AudioPlayerStatus.Idle, onIdle);
            player.off("error", onError);
        };

        const finish = error => {
            if (settled) return;
            settled = true;
            cleanup();

            if (error) reject(error);
            else resolve();
        };

        const onIdle = () => finish();
        const onError = error => finish(error);

        const timer = setTimeout(
            () => finish(new Error("Voice playback timed out.")),
            timeoutMs
        );

        player.on(AudioPlayerStatus.Idle, onIdle);
        player.on("error", onError);
    });
}

async function playSpeech(text) {
    if (!cfg.voiceChannel) {
        throw new Error("VOICE_CHANNEL_ID is missing from .env.");
    }

    const channel = await client.channels
        .fetch(cfg.voiceChannel)
        .catch(() => null);

    if (!channel) {
        throw new Error("The configured voice channel could not be found.");
    }

    if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
    ) {
        throw new Error("VOICE_CHANNEL_ID must be a voice or stage channel.");
    }

    let connection = getVoiceConnection(channel.guild.id);

    if (
        !connection ||
        connection.joinConfig.channelId !== channel.id
    ) {
        await joinConfiguredVoiceChannel();
        connection = getVoiceConnection(channel.guild.id);
    }

    if (!connection) {
        throw new Error("The bot is not connected to its configured voice channel.");
    }

    await entersState(connection, VoiceConnectionStatus.Ready, 30000);

    const me = await channel.guild.members.fetchMe();
    const permissions = channel.permissionsFor(me);

    if (!permissions?.has(PermissionFlagsBits.Connect)) {
        throw new Error("The bot needs Connect permission in its voice channel.");
    }

    if (!permissions?.has(PermissionFlagsBits.Speak)) {
        throw new Error("The bot needs Speak permission in its voice channel.");
    }

    connection.subscribe(speechPlayer);

    const audioPath = await generateWindowsSpeech(text);

    try {
        if (speechPlayer.state.status !== AudioPlayerStatus.Idle) {
            await waitForPlayerIdle(speechPlayer);
        }

        const resource = createAudioResource(audioPath, {
            inputType: StreamType.Arbitrary
        });

        const playbackFinished = waitForPlayerIdle(speechPlayer);
        speechPlayer.play(resource);

        await playbackFinished;
    } finally {
        await fs.unlink(audioPath).catch(() => {});
    }
}

async function processSpeechQueue() {
    if (speechQueueRunning) return;

    speechQueueRunning = true;

    try {
        while (speechQueue.length > 0) {
            const item = speechQueue.shift();

            try {
                await playSpeech(item.text);
                item.resolve?.();
            } catch (error) {
                console.error("[SPEECH] Announcement failed:", error.message);
                item.reject?.(error);
            }
        }
    } finally {
        speechQueueRunning = false;

        if (speechQueue.length > 0) {
            void processSpeechQueue();
        }
    }
}

function speakInVoiceChannel(text) {
    return new Promise((resolve, reject) => {
        speechQueue.push({
            text: String(text),
            resolve,
            reject
        });

        void processSpeechQueue();
    });
}

/* =========================================================
   GENERAL HELPERS
========================================================= */

function bannerForTitle(title) {
    const name = String(title || "").toLowerCase();

    if (/session|shutdown|vote/.test(name)) return cfg.sessionBanner || cfg.defaultBanner;
    if (/priority/.test(name)) return cfg.priorityBanner || cfg.defaultBanner;
    if (/ticket/.test(name)) return cfg.ticketBanner || cfg.defaultBanner;
    if (/moderation|warning|warn|ban|kick|timeout|purge/.test(name)) return cfg.moderationBanner || cfg.defaultBanner;
    if (/staff|promotion|infraction|application|feedback/.test(name)) return cfg.staffBanner || cfg.defaultBanner;
    if (/log|welcome|automated|server/.test(name)) return cfg.automatedBanner || cfg.defaultBanner;

    return cfg.defaultBanner;
}

function makeV2(title, body, rows = []) {
    const container = new ContainerBuilder()
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`# ${title}`)
        )
        .addSeparatorComponents(
            new SeparatorBuilder()
                .setSpacing(SeparatorSpacingSize.Small)
                .setDivider(true)
        );

    const bannerUrl = bannerForTitle(title);

    if (bannerUrl) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(bannerUrl)
            )
        );
    }

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            body || "No additional information."
        )
    );

    for (const actionRow of rows) {
        container.addActionRowComponents(actionRow);
    }

    return {
        flags: V2,
        components: [container],
        allowedMentions: { parse: [] }
    };
}

function row(...components) {
    return new ActionRowBuilder().addComponents(...components);
}

function button(id, label, style = ButtonStyle.Secondary) {
    return new ButtonBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style);
}

function clean(value, max = 1000) {
    return String(value ?? "")
        .replace(/\u0000/g, "")
        .trim()
        .slice(0, max) || "Not provided";
}

function isStaff(member) {
    return Boolean(
        member?.permissions?.has(PermissionFlagsBits.Administrator) ||
        (cfg.staffRole && member?.roles?.cache?.has(cfg.staffRole)) ||
        (cfg.adminRole && member?.roles?.cache?.has(cfg.adminRole)) ||
        (cfg.managementRole && member?.roles?.cache?.has(cfg.managementRole))
    );
}

function channelById(guild, id) {
    const channel = id && guild?.channels?.cache?.get(id);
    return channel?.isTextBased() ? channel : null;
}

async function replyPrivate(interaction, content) {
    const payload = {
        content,
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };

    if (interaction.replied || interaction.deferred) {
        return interaction.followUp(payload);
    }

    return interaction.reply(payload);
}

async function requireStaff(ctx) {
    if (isStaff(ctx.member)) return true;

    await replyPrivate(ctx, "You do not have permission to use this command.");
    return false;
}

async function sendLog(guild, content, staff = false) {
    const channel = channelById(
        guild,
        staff
            ? (cfg.staffLogChannel || cfg.logChannel)
            : cfg.logChannel
    );

    if (!channel) return;

    await channel.send(
        makeV2(staff ? "Staff Log" : "Server Log", content)
    ).catch(console.error);
}



/* =========================================================
   WELCOME MESSAGE — PLAIN TEXT, NOT AN EMBED
========================================================= */

function welcomeMessage(member) {
    const count = member.guild.memberCount;
    const emoji = cfg.welcomeEmoji?.trim() || "";


const greeting =
    `Welcome ${member} to **Texas Operations**, you're our ${count} member!`;


    const countButton = new ButtonBuilder()
        .setCustomId("welcome:membercount")
        .setLabel(`Members: ${count}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

    const supportButton = cfg.panelChannel
        ? new ButtonBuilder()
            .setLabel("Support")
            .setStyle(ButtonStyle.Link)
            .setURL(
                `https://discord.com/channels/${member.guild.id}/${cfg.panelChannel}`
            )
        : new ButtonBuilder()
            .setCustomId("welcome:support")
            .setLabel("Support")
            .setStyle(ButtonStyle.Secondary);

    return {
        content: `${emoji ? `${emoji} ` : ""}${greeting}`,
        components: [
            row(countButton, supportButton)
        ],
        allowedMentions: {
            users: [member.id]
        }
    };
}

function ordinal(number) {
    const remainder100 = number % 100;

    if (remainder100 >= 11 && remainder100 <= 13) {
        return `${number}th`;
    }

    switch (number % 10) {
        case 1: return `${number}st`;
        case 2: return `${number}nd`;
        case 3: return `${number}rd`;
        default: return `${number}th`;
    }
}


/* =========================================================
   VOICE CONNECTION
========================================================= */

async function joinConfiguredVoiceChannel() {
    if (voiceJoinInProgress) {
        return getVoiceConnection(cfg.guildId);
    }

    if (!cfg.voiceChannel) {
        console.warn("VOICE_CHANNEL_ID is not configured.");
        return;
    }

    voiceJoinInProgress = true;

    try {
        const channel = await client.channels
            .fetch(cfg.voiceChannel)
            .catch(() => null);

        if (!channel) {
            console.error("Voice channel not found. Check VOICE_CHANNEL_ID.");
            return;
        }

        if (
            channel.type !== ChannelType.GuildVoice &&
            channel.type !== ChannelType.GuildStageVoice
        ) {
            console.error("VOICE_CHANNEL_ID must be a voice or stage channel.");
            return;
        }

        const guild = channel.guild;
        const me = await guild.members.fetchMe();
        const permissions = channel.permissionsFor(me);

        if (!permissions?.has(PermissionFlagsBits.Connect)) {
            console.error("Bot is missing Connect permission in voice.");
            return;
        }

        if (!permissions?.has(PermissionFlagsBits.Speak)) {
            console.error("Bot is missing Speak permission in voice.");
        }

        let connection = getVoiceConnection(guild.id);

        if (
            connection &&
            connection.joinConfig.channelId === channel.id &&
            connection.state.status === VoiceConnectionStatus.Ready
        ) {
            connection.subscribe(speechPlayer);
            return connection;
        }

        if (connection) {
            connection.destroy();
        }

        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        connection.on("error", error => {
            console.error("Voice connection error:", error.message);
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000)
                ]);
            } catch {
                try {
                    connection.destroy();
                } catch {}

                setTimeout(() => {
                    joinConfiguredVoiceChannel().catch(console.error);
                }, 5000);
            }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 30000);
        connection.subscribe(speechPlayer);

        console.log(`Joined voice channel: ${channel.name}`);
        console.log("Voice audio player subscribed.");

        return connection;
    } catch (error) {
        console.error("Voice connection failed:", error.message);
    } finally {
        voiceJoinInProgress = false;
    }
}

/* =========================================================
   SESSION SYSTEM
========================================================= */

function sessionInfo() {
    return [
        `**Server Name:** ${cfg.serverName}`,
        `**Server Code:** ${cfg.serverCode}`,
        `**Server Link:** ${cfg.gameUrl || "Not configured"}`
    ].join("\n");
}

function sessionAnnouncement(title, description, quickJoin = false) {
    const rows = [];

    if (quickJoin && cfg.gameUrl) {
        rows.push(row(
            new ButtonBuilder()
                .setLabel("Quick Join")
                .setStyle(ButtonStyle.Link)
                .setURL(cfg.gameUrl)
        ));
    }

    return makeV2(
        title,
        `${description}\n\n## Server Information\n${sessionInfo()}`,
        rows
    );
}

function voteCounts(guildId) {
    const state = sessionVotes.get(guildId);
    let yes = 0;
    let no = 0;

    if (state) {
        for (const vote of state.votes.values()) {
            if (vote === "yes") yes++;
            if (vote === "no") no++;
        }
    }

    return { yes, no };
}

function votePanel(state) {
    const counts = voteCounts(state.guildId);

    return makeV2(
        "Session Vote",
        `A session vote has started for **${cfg.serverName}**.\n\n` +
        `Vote below if you want a session to begin.\n\n` +
        `**Required yes votes:** ${state.required}\n` +
        `**Yes votes:** ${counts.yes}\n` +
        `**No votes:** ${counts.no}\n\n${sessionInfo()}`,
        [row(
            button("session:yes", "Vote Yes", ButtonStyle.Success),
            button("session:no", "Vote No", ButtonStyle.Danger)
        )]
    );
}

async function refreshVote(guildId) {
    const state = sessionVotes.get(guildId);
    if (!state) return;

    const channel = await client.channels
        .fetch(state.channelId)
        .catch(() => null);

    if (!channel?.isTextBased()) return;

    const message = await channel.messages
        .fetch(state.messageId)
        .catch(() => null);

    if (message) {
        await message.edit(votePanel(state)).catch(console.error);
    }

    const counts = voteCounts(guildId);

    if (counts.yes >= state.required && !state.passed) {
        state.passed = true;

        await channel.send(sessionAnnouncement(
            "Session Vote Passed",
            `The vote reached ${counts.yes}/${state.required} yes votes. Staff can now start the session.`,
            true
        )).catch(console.error);

        await sendLog(
            channel.guild,
            `Session vote passed with ${counts.yes}/${state.required} yes votes.`,
            true
        );
    }
}

async function startSession(guild, user) {
    const channel = cfg.sessionChannel
        ? channelById(guild, cfg.sessionChannel)
        : null;

    const destination = channel || guild.systemChannel;

    if (!destination) {
        throw new Error(
            "Configure SESSION_VOTE_CHANNEL_ID or set a system channel."
        );
    }

    activeSessions.set(guild.id, {
        startedAt: Date.now(),
        startedBy: user.id
    });

    await destination.send(sessionAnnouncement(
        "Sessions",
        "Join Texas Operations! We're the best **Texas Operations** server!",
        true
    ));

    const oldVote = sessionVotes.get(guild.id);
    sessionVotes.delete(guild.id);

    if (oldVote) {
        const voteChannel = await client.channels
            .fetch(oldVote.channelId)
            .catch(() => null);

        if (voteChannel?.isTextBased()) {
            await voteChannel.send(makeV2(
                "Session Vote Ended",
                `A staff member started the session.\n\n${sessionInfo()}`
            )).catch(() => {});
        }
    }

    await sendLog(
        guild,
        `Session started by ${user.tag || user.username}.`,
        true
    );
}

async function shutdownSession(guild, user) {
    activeSessions.delete(guild.id);
    sessionVotes.delete(guild.id);

    const channel = cfg.sessionChannel
        ? channelById(guild, cfg.sessionChannel)
        : null;

    const destination = channel || guild.systemChannel;

    if (!destination) {
        throw new Error(
            "Configure SESSION_VOTE_CHANNEL_ID or set a system channel."
        );
    }

    await destination.send(sessionAnnouncement(
        "Session Shutdown",
        "The session is now closed. Thank you to everyone who attended."
    ));

    await sendLog(
        guild,
        `Session shutdown by ${user.tag || user.username}.`,
        true
    );
}

/* =========================================================
   TICKETS AND TRANSCRIPTS
========================================================= */

/* =========================================================
   TICKETS AND TRANSCRIPTS
========================================================= */

const ticketTypes = {
    general: {
        label: "General Support",
        prefix: "general",
        category: () => cfg.generalCategory,
        role: () => cfg.supportRole || cfg.staffRole
    },

    report: {
        label: "Report Tickets",
        prefix: "report",
        category: () => cfg.reportCategory,
        role: () => cfg.staffRole
    },

    management: {
        label: "Management Support",
        prefix: "management",
        category: () => cfg.managementCategory,
        role: () => cfg.managementRole || cfg.adminRole
    }
};

function ticketPanel() {
    return makeV2(
        "Texas Operations | Support Tickets",
        "Choose a department below to open a private ticket.\n\n" +
        "**General Support** — General questions and help.\n" +
        "**Report Tickets** — Report a player or incident.\n" +
        "**Management Support** — Management matters.",
        [row(
            new StringSelectMenuBuilder()
                .setCustomId("ticket:create")
                .setPlaceholder("Choose a ticket category")
                .addOptions(
                    {
                        label: "General Support",
                        value: "general"
                    },
                    {
                        label: "Report Tickets",
                        value: "report"
                    },
                    {
                        label: "Management Support",
                        value: "management"
                    }
                )
        )]
    );
}

function ticketChannelName(prefix, username) {
    const safeName = String(username)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "user";

    return `${prefix}-${safeName}`.slice(0, 100);
}

function findTicketKey(guildId, channelId) {
    for (const [key, id] of tickets) {
        if (key.startsWith(`${guildId}:`) && id === channelId) {
            return key;
        }
    }

    const channel = client.channels.cache.get(channelId);

    if (channel?.topic?.startsWith("texas-ticket:")) {
        const parts = channel.topic.split(":");

        if (parts.length >= 4 && parts[1] === guildId) {
            return `${parts[1]}:${parts[2]}:${parts[3]}`;
        }
    }

    return null;
}

async function createTicket(interaction, type) {
    const guild = interaction.guild;
    const user = interaction.user;
    const info = ticketTypes[type];

    if (!info) {
        return replyPrivate(interaction, "Unknown ticket type.");
    }

    const key = `${guild.id}:${user.id}:${type}`;
    const oldId = tickets.get(key);
    const oldChannel = oldId
        ? guild.channels.cache.get(oldId)
        : null;

    if (oldChannel) {
        return replyPrivate(interaction, `You already have a ticket: ${oldChannel}`);
    }

    const existing = guild.channels.cache.find(channel =>
        channel.topic === `texas-ticket:${guild.id}:${user.id}:${type}`
    );

    if (existing) {
        tickets.set(key, existing.id);
        return replyPrivate(interaction, `You already have a ticket: ${existing}`);
    }

    const categoryId = info.category();

    if (!categoryId || !guild.channels.cache.has(categoryId)) {
        return replyPrivate(
            interaction,
            `The ${info.label} category ID is missing or invalid in .env.`
        );
    }

    const overwrites = [
        {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
        },
        {
            id: user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles
            ]
        },
        {
            id: client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.AttachFiles
            ]
        }
    ];

    const staffRole = info.role();

    if (staffRole && guild.roles.cache.has(staffRole)) {
        overwrites.push({
            id: staffRole,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles
            ]
        });
    }

    try {
        const channel = await guild.channels.create({
            name: ticketChannelName(info.prefix, user.username),
            type: ChannelType.GuildText,
            parent: categoryId,
            topic: `texas-ticket:${guild.id}:${user.id}:${type}`,
            permissionOverwrites: overwrites,
            reason: `${info.label} ticket opened by ${user.tag}`
        });

        tickets.set(key, channel.id);

        await channel.send(makeV2(
            info.label,
            `Welcome ${user}!\n\n` +
            "Please explain your request and include any relevant details.\n\n" +
            `**Opened by:** ${user.tag}\n` +
            `**Department:** ${info.label}`,
            [row(
                button("ticket:claim", "Claim Ticket"),
                button("ticket:close", "Close Ticket", ButtonStyle.Danger)
            )]
        ));

        await replyPrivate(interaction, `Your ticket has been created: ${channel}`);

        await sendLog(
            guild,
            `Ticket created: ${channel}\n` +
            `Department: ${info.label}\n` +
            `Opened by: ${user.tag} (${user.id})`,
            true
        );
    } catch (error) {
        console.error("Ticket creation failed:", error);

        await replyPrivate(
            interaction,
            "Ticket creation failed. Check the category ID and the bot's Manage Channels permission."
        );
    }
}

async function claimTicket(interaction) {
    if (!isStaff(interaction.member)) {
        return replyPrivate(interaction, "Only staff can claim tickets.");
    }

    if (!findTicketKey(interaction.guildId, interaction.channelId)) {
        return replyPrivate(interaction, "This is not a recognized ticket channel.");
    }

    claims.set(interaction.channelId, interaction.user.id);

    await interaction.channel.send(makeV2(
        "Ticket Claimed",
        `This ticket is now being handled by ${interaction.user}.`
    ));

    await replyPrivate(interaction, "Ticket claimed.");

    await sendLog(
        interaction.guild,
        `${interaction.user.tag} claimed ${interaction.channel}.`,
        true
    );
}

async function makeTicketTranscript(channel, closingUser, reason) {
    const messages = [];
    let before;

    for (let page = 0; page < 10; page++) {
        const batch = await channel.messages.fetch({
            limit: 100,
            ...(before ? { before } : {})
        }).catch(error => {
            console.error("Transcript message fetch failed:", error.message);
            return null;
        });

        if (!batch?.size) break;

        messages.push(...batch.values());
        before = batch.last().id;

        if (batch.size < 100) break;
    }

    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const lines = [
        "TEXAS OPERATIONS - TICKET TRANSCRIPT",
        `Server: ${channel.guild.name} (${channel.guild.id})`,
        `Channel: #${channel.name} (${channel.id})`,
        `Closed by: ${closingUser.tag || closingUser.username} (${closingUser.id})`,
        `Closure reason: ${reason}`,
        `Generated: ${new Date().toISOString()}`,
        `Messages included: ${messages.length}`,
        "=".repeat(70),
        ""
    ];

    for (const message of messages) {
        const timestamp = new Date(message.createdTimestamp).toISOString();

        const author = message.author
            ? `${message.author.tag || message.author.username} (${message.author.id})`
            : "Unknown user";

        let content = message.content || "";

        if (message.embeds?.length) {
            content += "\n[Embeds: " + message.embeds.length + "]";
        }

        if (message.attachments?.size) {
            content += "\nAttachments:\n" +
                message.attachments.map(a => a.url).join("\n");
        }

        if (message.stickers?.size) {
            content += "\n[Stickers: " +
                message.stickers.map(s => s.name).join(", ") + "]";
        }

        if (!content.trim()) content = "[No text content]";

        lines.push(`[${timestamp}] ${author}`);
        lines.push(content);
        lines.push("-".repeat(50));
    }

    return Buffer.from(lines.join("\n"), "utf8");
}

async function closeTicketChannel(channel, closingUser, reason) {
    const key = findTicketKey(channel.guild.id, channel.id);

    if (!key) {
        throw new Error("This is not a recognized ticket channel.");
    }

    const ownerId = key.split(":")[1];
    const closureReason = clean(reason, 1000);

    const transcript = await makeTicketTranscript(
        channel,
        closingUser,
        closureReason
    );

    const attachment = new AttachmentBuilder(transcript, {
        name: `texas-ticket-${channel.id}-transcript.txt`,
        description: "Texas Operations ticket transcript"
    });

    let dmSent = false;

    try {
        const owner = await client.users.fetch(ownerId);

        await owner.send({
            content:
                `Your Texas Operations ticket **#${channel.name}** has been closed.\n` +
                `**Closed by:** ${closingUser.tag || closingUser.username}\n` +
                `**Reason:** ${closureReason}\n\n` +
                "Your ticket transcript is attached.",
            files: [attachment],
            allowedMentions: { parse: [] }
        });

        dmSent = true;
    } catch (error) {
        console.error("Could not DM ticket transcript:", error.message);
    }

    await sendLog(
        channel.guild,
        `**Ticket closed:** #${channel.name}\n` +
        `**Ticket owner:** <@${ownerId}> (${ownerId})\n` +
        `**Closed by:** ${closingUser.tag || closingUser.username} (${closingUser.id})\n` +
        `**Reason:** ${closureReason}\n` +
        `**Transcript DM:** ${dmSent ? "Sent successfully" : "Could not deliver; the user's DMs may be disabled"}`,
        true
    );

    tickets.delete(key);
    claims.delete(channel.id);

    await channel.send(makeV2(
        "Ticket Closed",
        `**Closed by:** ${closingUser}\n` +
        `**Reason:** ${closureReason}\n` +
        `**Transcript DM:** ${dmSent ? "Sent to the ticket owner." : "Could not DM the owner."}\n\n` +
        "This channel will be deleted shortly."
    )).catch(() => {});

    setTimeout(() => {
        channel.delete(
            `Ticket closed by ${closingUser.tag || closingUser.username}. Reason: ${closureReason}`
        ).catch(console.error);
    }, 3000);

    return { dmSent };
}

async function closeTicket(interaction) {
    const channel = interaction.channel;
    const key = findTicketKey(interaction.guildId, channel.id);

    if (!key) {
        return replyPrivate(interaction, "This is not a recognized ticket.");
    }

    const ownerId = key.split(":")[1];

    if (ownerId !== interaction.user.id && !isStaff(interaction.member)) {
        return replyPrivate(
            interaction,
            "Only the ticket owner or staff can close this ticket."
        );
    }

    const modal = new ModalBuilder()
        .setCustomId("ticket:close:reason")
        .setTitle("Close Ticket");

    const reasonInput = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason for closing")
        .setPlaceholder("Explain why this ticket is being closed")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true);

    modal.addComponents(row(reasonInput));

    return interaction.showModal(modal);
}

async function submitTicketClosure(interaction) {
    const channel = interaction.channel;
    const key = findTicketKey(interaction.guildId, channel.id);

    if (!key) {
        return replyPrivate(interaction, "This ticket is no longer recognized.");
    }

    const ownerId = key.split(":")[1];

    if (ownerId !== interaction.user.id && !isStaff(interaction.member)) {
        return replyPrivate(
            interaction,
            "Only the ticket owner or staff can close this ticket."
        );
    }

    const reason = clean(
        interaction.fields.getTextInputValue("reason"),
        1000
    );

    await replyPrivate(interaction, "Closing ticket and generating transcript...");

    try {
        const result = await closeTicketChannel(
            channel,
            interaction.user,
            reason
        );

        if (!result.dmSent) {
            await interaction.followUp({
                content:
                    "The ticket was closed, but the transcript DM could not be delivered. The user may have DMs disabled.",
                flags: EPHEMERAL
            }).catch(() => {});
        }
    } catch (error) {
        console.error("Ticket closure failed:", error);

        await interaction.followUp({
            content: `Ticket closure failed: ${error.message}`,
            flags: EPHEMERAL
        }).catch(() => {});
    }
}
/* =========================================================
   PRIORITY SCENES
========================================================= */

function priorityPanel() {
    return makeV2(
        "Priority Scene Control",
        "Choose a scene type, then enter its location. The bot will update the voice channel status and speak using an installed Windows voice where available.",
        [row(
            new StringSelectMenuBuilder()
                .setCustomId("priority:choose")
                .setPlaceholder("Choose a priority scene")
                .addOptions(
                    { label: "Vehicle Pursuit", value: "Vehicle Pursuit" },
                    { label: "Hostage Scene", value: "Hostage Scene" }
                )
        )]
    );
}

async function endPriority(guild, user) {
    const previous = priorities.get(guild.id);

    priorities.delete(guild.id);

    if (cfg.voiceChannel) {
        const voice = await client.channels
            .fetch(cfg.voiceChannel)
            .catch(() => null);

        if (voice && typeof voice.setStatus === "function") {
            await voice.setStatus("").catch(error => {
                console.error("Could not clear voice status:", error.message);
            });
        }
    }

    await sendLog(
        guild,
        `Priority ended by ${user.tag || user.username}.` +
        (previous
            ? ` Previous scene: ${previous.scene} at ${previous.location}.`
            : ""),
        true
    );
}

/* =========================================================
   SLASH COMMAND DEFINITIONS
========================================================= */

const sessionCommand = new SlashCommandBuilder()
    .setName("session")
    .setDescription("Manage roleplay sessions")
    .addSubcommand(s => s
        .setName("vote")
        .setDescription("Start a session vote")
        .addIntegerOption(o => o
            .setName("required_votes")
            .setDescription("Number of yes votes required")
            .setMinValue(1)
            .setMaxValue(500)))
    .addSubcommand(s => s
        .setName("start")
        .setDescription("Announce that the session is open"))
    .addSubcommand(s => s
        .setName("shutdown")
        .setDescription("Announce that the session is closed"));

const commands = [
    new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show bot commands"),

    new SlashCommandBuilder()
        .setName("ticketpanel")
        .setDescription("Send the ticket panel"),

    new SlashCommandBuilder()
        .setName("priority")
        .setDescription("Open priority controls"),

    new SlashCommandBuilder()
        .setName("endpriority")
        .setDescription("End the active priority"),

    sessionCommand,

    new SlashCommandBuilder()
        .setName("feedback")
        .setDescription("Submit feedback")
        .addIntegerOption(o => o
            .setName("rating")
            .setDescription("Rating from 0 to 5")
            .setMinValue(0)
            .setMaxValue(5)
            .setRequired(true))
        .addStringOption(o => o
            .setName("message")
            .setDescription("Feedback text")
            .setRequired(true)
            .setMaxLength(1000)),

    new SlashCommandBuilder()
        .setName("appresult")
        .setDescription("Publish an application result")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Applicant")
            .setRequired(true))
        .addStringOption(o => o
            .setName("result")
            .setDescription("Result")
            .setRequired(true)
            .addChoices(
                { name: "Pass", value: "Pass" },
                { name: "Fail", value: "Fail" }
            ))
        .addIntegerOption(o => o
            .setName("score")
            .setDescription("Score out of 100")
            .setMinValue(0)
            .setMaxValue(100))
        .addStringOption(o => o
            .setName("notes")
            .setDescription("Notes")
            .setMaxLength(1000)),

    new SlashCommandBuilder()
        .setName("promotion")
        .setDescription("Announce a promotion")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Member")
            .setRequired(true))
        .addStringOption(o => o
            .setName("rank")
            .setDescription("New rank")
            .setRequired(true))
        .addStringOption(o => o
            .setName("reason")
            .setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("infraction")
        .setDescription("Record an infraction")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Member")
            .setRequired(true))
        .addStringOption(o => o
            .setName("type")
            .setDescription("Infraction type")
            .setRequired(true)
            .addChoices(
                { name: "Warning", value: "Warning" },
                { name: "Strike", value: "Strike" },
                { name: "Demotion", value: "Demotion" },
                { name: "Termination", value: "Termination" }
            ))
        .addStringOption(o => o
            .setName("reason")
            .setDescription("Reason")
            .setRequired(true)),

    new SlashCommandBuilder()
        .setName("say")
        .setDescription("Send a plain-text message")
        .addStringOption(o => o
            .setName("message")
            .setDescription("Message to send")
            .setRequired(true)
            .setMaxLength(2000)),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription("Kick a member")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Member")
            .setRequired(true))
        .addStringOption(o => o
            .setName("reason")
            .setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a member")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Member")
            .setRequired(true))
        .addStringOption(o => o
            .setName("reason")
            .setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("unban")
        .setDescription("Unban a user by ID")
        .addStringOption(o => o
            .setName("userid")
            .setDescription("User ID")
            .setRequired(true))
        .addStringOption(o => o
            .setName("reason")
            .setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("timeout")
        .setDescription("Timeout a member")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Member")
            .setRequired(true))
        .addIntegerOption(o => o
            .setName("minutes")
            .setDescription("Duration in minutes")
            .setMinValue(1)
            .setMaxValue(40320)
            .setRequired(true))
        .addStringOption(o => o
            .setName("reason")
            .setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("untimeout")
        .setDescription("Remove a timeout")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Member")
            .setRequired(true))
        .addStringOption(o => o
            .setName("reason")
            .setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Delete messages")
        .addIntegerOption(o => o
            .setName("amount")
            .setDescription("Number from 1 to 100")
            .setMinValue(1)
            .setMaxValue(100)
            .setRequired(true)),

    new SlashCommandBuilder()
        .setName("warn")
        .setDescription("Warn a member")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Member")
            .setRequired(true))
        .addStringOption(o => o
            .setName("reason")
            .setDescription("Reason")
            .setRequired(true)),

    new SlashCommandBuilder()
        .setName("dm")
        .setDescription("Send a direct message to a user")
        .addUserOption(o => o
            .setName("user")
            .setDescription("Recipient")
            .setRequired(true))
        .addStringOption(o => o
            .setName("message")
            .setDescription("Message")
            .setRequired(true)
            .setMaxLength(2000))
].map(command => command.toJSON());

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(cfg.token);

    const route = cfg.guildId
        ? Routes.applicationGuildCommands(cfg.clientId, cfg.guildId)
        : Routes.applicationCommands(cfg.clientId);

    await rest.put(route, { body: commands });

    console.log(`Registered ${commands.length} slash commands.`);
}

/* =========================================================
   COMMAND HANDLER
========================================================= */

async function executeCommand(ctx, name, args = {}) {
    const interaction = ctx.isChatInputCommand();
    const guild = ctx.guild;
    const user = ctx.user || ctx.author;

    const get = (key, type = "string") => {
        if (!interaction) return args[key] ?? null;
        if (type === "user") return ctx.options.getUser(key);
        if (type === "integer") return ctx.options.getInteger(key);
        return ctx.options.getString(key);
    };

    const reply = message =>
        interaction ? replyPrivate(ctx, message) : ctx.reply(message);

    switch (name) {
        case "help":
            return reply(makeV2(
                "Texas Operations Commands",
                "**Sessions:** `/session vote`, `/session start`, `/session shutdown`\n" +
                "**Tickets:** `/ticketpanel`\n" +
                "**Priority:** `/priority`, `/endpriority`\n" +
                "**Staff:** `/promotion`, `/infraction`, `/appresult`\n" +
                "**Moderation:** `/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/purge`, `/warn`\n" +
                "**Other:** `/feedback`, `/say`, `/dm`\n\n" +
                "**Prefix commands:** `!help`, `-help`, `!ticketpanel`, `-ticketpanel`, `!priority`, `-priority`, `!endpriority`, `-endpriority`, `!say`, `-say`, `!dm`, `-dm`, `!purge`, `-purge`, `!kick`, `-kick`, `!ban`, `-ban`, `!unban`, `-unban`, `!timeout`, `-timeout`, `!untimeout`, `-untimeout`, `!warn`, `-warn`, `!promotion`, `-promotion`, `!infraction`, `-infraction`, `!appresult`, `-appresult`, `!feedback`, `-feedback`, `!session`, `-session`"
            ));

        case "session": {
            if (!await requireStaff(ctx)) return;

            const sub = interaction
                ? ctx.options.getSubcommand()
                : args.subcommand;

            if (sub === "vote") {
                const required =
                    get("required_votes", "integer") ||
                    cfg.requiredVotes;

                const channel = cfg.sessionChannel
                    ? channelById(guild, cfg.sessionChannel)
                    : ctx.channel;

                if (!channel) {
                    return reply("The session vote channel is not configured.");
                }

                const state = {
                    guildId: guild.id,
                    required,
                    votes: new Map(),
                    channelId: channel.id,
                    messageId: null,
                    passed: false
                };

                const sent = await channel.send(votePanel(state));

                state.messageId = sent.id;
                sessionVotes.set(guild.id, state);

                await sendLog(
                    guild,
                    `Session vote started by ${user.tag}. Required yes votes: ${required}.`,
                    true
                );

                return reply(
                    `Session vote started in ${channel}; ${required} yes votes are required.`
                );
            }

            if (sub === "start") {
                try {
                    await startSession(guild, user);
                    return reply("Session start announcement published.");
                } catch (error) {
                    return reply(`Could not start session: ${error.message}`);
                }
            }

            if (sub === "shutdown") {
                try {
                    await shutdownSession(guild, user);
                    return reply("Session shutdown announcement published.");
                } catch (error) {
                    return reply(`Could not shut down session: ${error.message}`);
                }
            }

            return reply("Usage: session vote, session start, or session shutdown.");
        }

        case "ticketpanel":
            if (!await requireStaff(ctx)) return;
            await ctx.channel.send(ticketPanel());
            return reply("Ticket panel sent.");

        case "priority":
            if (!await requireStaff(ctx)) return;

            if (interaction) {
                return ctx.reply({
                    ...priorityPanel(),
                    flags: V2 | EPHEMERAL
                });
            }

            return ctx.reply(priorityPanel());

        case "endpriority":
            if (!await requireStaff(ctx)) return;
            await endPriority(guild, user);
            return reply("Priority ended.");

        case "feedback": {
            const destination = channelById(guild, cfg.feedbackChannel);

            if (!destination) {
                return reply("Feedback channel is not configured.");
            }

            await destination.send(makeV2(
                "Texas Operations Feedback",
                `**From:** ${user.tag || user.username}\n` +
                `**Rating:** ${get("rating", "integer")}/5\n` +
                `**Feedback:** ${clean(get("message"))}`
            ));

            await sendLog(
                guild,
                `Feedback submitted by ${user.tag || user.username}.`,
                true
            );

            return reply("Thank you. Your feedback has been submitted.");
        }

        case "appresult": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const result = get("result");
            const score = get("score", "integer");
            const notes = get("notes") || "No notes provided.";

            if (!target || !result) {
                return reply("Usage: appresult @user Pass/Fail [score] [notes].");
            }

            const destination =
                channelById(guild, cfg.applicationChannel) || ctx.channel;

            await destination.send(makeV2(
                `Application ${result}`,
                `**Applicant:** ${target}\n` +
                `**Result:** ${result}\n` +
                `**Score:** ${score == null ? "Not provided" : `${score}/100`}\n` +
                `**Reviewed by:** ${user}\n` +
                `**Notes:** ${notes}`
            ));

            await sendLog(
                guild,
                `Application result (${result}) published for ${target.tag} by ${user.tag}.`,
                true
            );

            return reply("Application result published.");
        }

        case "promotion": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const rank = clean(get("rank"), 100);
            const reason = get("reason") || "No reason provided.";

            if (!target || rank === "Not provided") {
                return reply("Usage: promotion @user NewRank [reason].");
            }

            await ctx.channel.send(makeV2(
                "Staff Promotion",
                `Congratulations to ${target}!\n\n` +
                `**New rank:** ${rank}\n` +
                `**Reason:** ${reason}\n` +
                `**Announced by:** ${user}`
            ));

            await sendLog(
                guild,
                `${target.tag} promoted to ${rank} by ${user.tag}. Reason: ${reason}`,
                true
            );

            return reply("Promotion announced.");
        }

        case "infraction": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const type = get("type");
            const reason = clean(get("reason"));

            if (!target || !type || reason === "Not provided") {
                return reply("Usage: infraction @user Warning/Strike/Demotion/Termination reason.");
            }

            await ctx.channel.send(makeV2(
                "Staff Infraction",
                `**Member:** ${target}\n` +
                `**Type:** ${type}\n` +
                `**Reason:** ${reason}\n` +
                `**Issued by:** ${user}`
            ));

            await sendLog(
                guild,
                `${type} issued to ${target.tag} by ${user.tag}. Reason: ${reason}`,
                true
            );

            return reply("Infraction recorded.");
        }

        case "say": {
            if (!await requireStaff(ctx)) return;

            const message = clean(get("message"), 2000);

            if (message === "Not provided") {
                return reply("Provide a message to send.");
            }

            await ctx.channel.send({
                content: message,
                allowedMentions: { parse: [] }
            });

            return reply("Message sent.");
        }

        case "kick": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const reason = get("reason") || `Kicked by ${user.tag}`;
            const member = target
                ? await guild.members.fetch(target.id).catch(() => null)
                : null;

            if (!member) return reply("Member not found.");
            if (!member.kickable) {
                return reply("I cannot kick this member. Check role hierarchy.");
            }

            await member.kick(reason);

            await sendLog(
                guild,
                `${target.tag} kicked by ${user.tag}. Reason: ${reason}`,
                true
            );

            return reply(`Kicked ${target.tag}.`);
        }

        case "ban": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const reason = get("reason") || `Banned by ${user.tag}`;
            const member = target
                ? await guild.members.fetch(target.id).catch(() => null)
                : null;

            if (member && !member.bannable) {
                return reply("I cannot ban this member. Check role hierarchy.");
            }

            if (!target) return reply("Member not found.");

            await guild.members.ban(target.id, { reason });

            await sendLog(
                guild,
                `${target.tag} banned by ${user.tag}. Reason: ${reason}`,
                true
            );

            return reply(`Banned ${target.tag}.`);
        }

        case "unban": {
            if (!await requireStaff(ctx)) return;

            const id = String(get("userid") || "");

            if (!/^\d{17,20}$/.test(id)) {
                return reply("Enter a valid Discord user ID.");
            }

            await guild.members.unban(
                id,
                get("reason") || `Unbanned by ${user.tag}`
            );

            await sendLog(
                guild,
                `User ID ${id} unbanned by ${user.tag}.`,
                true
            );

            return reply(`Unbanned user ID ${id}.`);
        }

        case "timeout": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const minutes = Number(get("minutes", "integer"));
            const member = target
                ? await guild.members.fetch(target.id).catch(() => null)
                : null;

            if (!member) return reply("Member not found.");
            if (!member.moderatable) {
                return reply("I cannot timeout this member. Check role hierarchy.");
            }

            await member.timeout(
                minutes * 60000,
                get("reason") || `Timed out by ${user.tag}`
            );

            await sendLog(
                guild,
                `${target.tag} timed out for ${minutes} minutes by ${user.tag}.`,
                true
            );

            return reply(`Timed out ${target.tag} for ${minutes} minutes.`);
        }

        case "untimeout": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const member = target
                ? await guild.members.fetch(target.id).catch(() => null)
                : null;

            if (!member) return reply("Member not found.");
            if (!member.moderatable) {
                return reply("I cannot modify this member.");
            }

            await member.timeout(
                null,
                get("reason") || `Timeout removed by ${user.tag}`
            );

            await sendLog(
                guild,
                `Timeout removed from ${target.tag} by ${user.tag}.`,
                true
            );

            return reply(`Timeout removed from ${target.tag}.`);
        }

        case "purge": {
            if (!await requireStaff(ctx)) return;

            const amount = Number(get("amount", "integer"));

            if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
                return reply("Amount must be between 1 and 100.");
            }

            const deleted = await ctx.channel.bulkDelete(amount, true);

            await sendLog(
                guild,
                `${user.tag} purged ${deleted.size} messages in #${ctx.channel.name}.`,
                true
            );

            return reply(`Deleted ${deleted.size} messages.`);
        }

        case "warn": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const reason = clean(get("reason"));

            if (!target) return reply("Member not found.");

            const key = `${guild.id}:${target.id}`;
            const list = warnings.get(key) || [];

            list.push({
                reason,
                moderator: user.id,
                time: Date.now()
            });

            warnings.set(key, list);

            await sendLog(
                guild,
                `${target.tag} warned by ${user.tag}. Reason: ${reason}. Warnings this session: ${list.length}`,
                true
            );

            return reply(
                `Warned ${target.tag}. Warning count this session: ${list.length}.`
            );
        }

        case "dm": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const message = clean(get("message"), 2000);

            if (!target || message === "Not provided") {
                return reply("Provide a user and a message.");
            }

            try {
                await target.send({
                    content: `Message from Texas Operations staff:\n\n${message}`,
                    allowedMentions: { parse: [] }
                });

                await sendLog(
                    guild,
                    `Staff DM sent to ${target.tag} by ${user.tag}.`,
                    true
                );

                return reply(`Message sent to ${target.tag}.`);
            } catch {
                return reply("Could not DM this user. Their DMs may be disabled.");
            }
        }
    }
}

/* =========================================================
   READY AND MEMBER EVENTS
========================================================= */

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(
        `Prefix commands enabled: ${[...new Set([cfg.prefix, "!", "-"])].join(", ")}`
    );
    console.log("Texas Operations is online.");
    console.log("Windows speech mode: installed male voice preferred.");
    console.log("One-unit-at-a-time system: removed.");

    await joinConfiguredVoiceChannel();
});

client.on("guildCreate", async guild => {
    console.log(`Joined server ${guild.name}.`);
    await joinConfiguredVoiceChannel();
});

client.on("guildMemberAdd", async member => {
    const channel = channelById(member.guild, cfg.welcomeChannel);

    if (channel) {
        await channel.send(welcomeMessage(member)).catch(console.error);
    }

    await sendLog(member.guild, `${member.user.tag} joined the server.`);
});

client.on("guildMemberRemove", async member => {
    await sendLog(member.guild, `${member.user.tag} left the server.`);
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
    const added = newMember.roles.cache.filter(
        role => !oldMember.roles.cache.has(role.id)
    );

    const removed = oldMember.roles.cache.filter(
        role => !newMember.roles.cache.has(role.id)
    );

    if (added.size) {
        await sendLog(
            newMember.guild,
            `${newMember.user.tag} received role(s): ${added.map(r => r.name).join(", ")}`
        );
    }

    if (removed.size) {
        await sendLog(
            newMember.guild,
            `${newMember.user.tag} lost role(s): ${removed.map(r => r.name).join(", ")}`
        );
    }

    if (oldMember.nickname !== newMember.nickname) {
        await sendLog(
            newMember.guild,
            `${newMember.user.tag} changed nickname from "${oldMember.nickname || "none"}" to "${newMember.nickname || "none"}".`
        );
    }
});

/* =========================================================
   MESSAGE AND SERVER LOGGING
========================================================= */

client.on("messageDelete", async message => {
    if (!message.guild || message.author?.bot) return;

    const attachments = message.attachments?.size
        ? message.attachments.map(a => a.url).join("\n")
        : "None";

    await sendLog(
        message.guild,
        `Message deleted in ${message.channel}.\n` +
        `**Author:** ${message.author?.tag || "Unknown"}\n` +
        `**Content:** ${clean(message.content, 1200)}\n` +
        `**Attachments:** ${attachments}`
    );
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
    if (
        !newMessage.guild ||
        newMessage.author?.bot ||
        oldMessage.content === newMessage.content
    ) return;

    await sendLog(
        newMessage.guild,
        `Message edited in ${newMessage.channel}.\n` +
        `**Author:** ${newMessage.author?.tag || "Unknown"}\n` +
        `**Before:** ${clean(oldMessage.content, 500)}\n` +
        `**After:** ${clean(newMessage.content, 500)}`
    );
});

client.on("voiceStateUpdate", async (oldState, newState) => {
    const member = newState.member || oldState.member;

    if (!member || member.user.bot) return;

    if (!oldState.channelId && newState.channelId) {
        await sendLog(
            member.guild,
            `${member.user.tag} joined voice channel ${newState.channel?.name}.`
        );
    } else if (oldState.channelId && !newState.channelId) {
        await sendLog(
            member.guild,
            `${member.user.tag} left voice channel ${oldState.channel?.name}.`
        );
    } else if (oldState.channelId !== newState.channelId) {
        await sendLog(
            member.guild,
            `${member.user.tag} moved from ${oldState.channel?.name} to ${newState.channel?.name}.`
        );
    }
});

client.on("channelCreate", channel => {
    if (channel.guild) {
        sendLog(channel.guild, `Channel created: ${channel.name} (${channel.id}).`);
    }
});

client.on("channelDelete", channel => {
    if (channel.guild) {
        sendLog(channel.guild, `Channel deleted: ${channel.name} (${channel.id}).`);
    }
});

client.on("channelUpdate", (oldChannel, newChannel) => {
    if (newChannel.guild && oldChannel.name !== newChannel.name) {
        sendLog(
            newChannel.guild,
            `Channel renamed from ${oldChannel.name} to ${newChannel.name}.`
        );
    }
});

client.on("roleCreate", role => {
    sendLog(role.guild, `Role created: ${role.name}.`);
});

client.on("roleDelete", role => {
    sendLog(role.guild, `Role deleted: ${role.name}.`);
});

client.on("roleUpdate", (oldRole, newRole) => {
    if (oldRole.name !== newRole.name) {
        sendLog(
            newRole.guild,
            `Role renamed from ${oldRole.name} to ${newRole.name}.`
        );
    }
});

client.on("guildBanAdd", ban => {
    sendLog(ban.guild, `${ban.user.tag} was banned.`);
});

client.on("guildBanRemove", ban => {
    sendLog(ban.guild, `${ban.user.tag} was unbanned.`);
});

/* =========================================================
   PREFIX COMMANDS
========================================================= */

client.on("messageCreate", async message => {
    if (!message.guild || message.author.bot) return;

    const prefixes = [...new Set(
        [cfg.prefix, "!", "-"].filter(Boolean)
    )].sort((a, b) => b.length - a.length);

    const prefix = prefixes.find(p => message.content.startsWith(p));
    if (!prefix) return;

    const input = message.content.slice(prefix.length).trim();
    if (!input) return;

    const [commandRaw, ...rest] = input.split(/\s+/);
    const name = commandRaw.toLowerCase();
    const restText = rest.join(" ");

    const ctx = {
        guild: message.guild,
        member: message.member,
        user: message.author,
        author: message.author,
        channel: message.channel,
        reply: message.reply.bind(message),
        isChatInputCommand: () => false
    };

    const args = {};

    try {
        if (name === "session") {
            const [subcommand, ...subArgs] = rest;
            args.subcommand = (subcommand || "").toLowerCase();

            if (args.subcommand === "vote") {
                args.required_votes = Number(subArgs[0]) || cfg.requiredVotes;
            }

            return await executeCommand(ctx, "session", args);
        }

        if (name === "priority") {
            return await executeCommand(ctx, "priority", args);
        }

        if (name === "endpriority") {
            return await executeCommand(ctx, "endpriority", args);
        }

        if (name === "ticketpanel") {
            return await executeCommand(ctx, "ticketpanel", args);
        }

        if (name === "help") {
            return await executeCommand(ctx, "help", args);
        }

        if (name === "say") {
            args.message = restText;
            return await executeCommand(ctx, "say", args);
        }

        if (name === "dm") {
            const match = restText.match(/^(<@!?(\d+)>|\d+)\s+([\s\S]+)/);

            if (!match) {
                return message.reply(`Usage: ${prefix}dm @user message`);
            }

            const id = match[2] || match[1].replace(/[<@!>]/g, "");
            const target = await client.users.fetch(id).catch(() => null);

            if (!target) return message.reply("User not found.");

            args.user = target;
            args.message = match[3];

            return await executeCommand(ctx, "dm", args);
        }

        if (name === "purge") {
            args.amount = Number(restText);

            if (!Number.isInteger(args.amount) || args.amount < 1 || args.amount > 100) {
                return message.reply(`Usage: ${prefix}purge 1-100`);
            }

            return await executeCommand(ctx, "purge", args);
        }

        const userCommands = [
            "kick", "ban", "timeout", "untimeout", "warn",
            "promotion", "infraction", "appresult", "unban"
        ];

        if (userCommands.includes(name)) {
            if (!isStaff(message.member)) {
                return message.reply("You do not have permission to use this command.");
            }

            if (name === "unban") {
                const pieces = restText.split(/\s+/);
                args.userid = pieces.shift();
                args.reason = pieces.join(" ") || undefined;

                return await executeCommand(ctx, "unban", args);
            }

            const userMatch = restText.match(/^(<@!?(\d+)>|\d+)\s*([\s\S]*)/);

            if (!userMatch) {
                return message.reply(`Usage: ${prefix}${name} @user ...`);
            }

            const id = userMatch[2] || userMatch[1].replace(/[<@!>]/g, "");
            const target = await client.users.fetch(id).catch(() => null);

            if (!target) return message.reply("User not found.");

            args.user = target;
            const remaining = userMatch[3].trim();

            if (name === "kick" || name === "ban" || name === "untimeout") {
                args.reason = remaining || undefined;
            } else if (name === "timeout") {
                const pieces = remaining.split(/\s+/);
                args.minutes = Number(pieces.shift());
                args.reason = pieces.join(" ") || undefined;

                if (!Number.isInteger(args.minutes) || args.minutes < 1 || args.minutes > 40320) {
                    return message.reply(`Usage: ${prefix}timeout @user minutes reason`);
                }
            } else if (name === "warn") {
                args.reason = remaining;
            } else if (name === "promotion") {
                const pieces = remaining.split(/\s+/);
                args.rank = pieces.shift();
                args.reason = pieces.join(" ") || undefined;
            } else if (name === "infraction") {
                const pieces = remaining.split(/\s+/);
                args.type = pieces.shift();
                args.reason = pieces.join(" ");
            } else if (name === "appresult") {
                const pieces = remaining.split(/\s+/);
                args.result = pieces.shift();
                args.score = pieces.length ? Number(pieces.shift()) : null;
                args.notes = pieces.join(" ");
            }

            return await executeCommand(ctx, name, args);
        }

        if (name === "feedback") {
            const match = restText.match(/^([0-5])\s+([\s\S]+)/);

            if (!match) {
                return message.reply(`Usage: ${prefix}feedback 0-5 message`);
            }

            args.rating = Number(match[1]);
            args.message = match[2];

            return await executeCommand(ctx, "feedback", args);
        }
    } catch (error) {
        console.error(`Prefix command ${name} failed:`, error);

        await message.reply(
            "Command failed. Check the terminal and bot permissions."
        ).catch(() => {});
    }
});

/* =========================================================
   INTERACTIONS
========================================================= */

client.on("interactionCreate", async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            return await executeCommand(
                interaction,
                interaction.commandName
            );
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === "ticket:create") {
                return await createTicket(
                    interaction,
                    interaction.values[0]
                );
            }

            if (interaction.customId === "priority:choose") {
                if (!isStaff(interaction.member)) {
                    return replyPrivate(
                        interaction,
                        "Only staff can activate priority scenes."
                    );
                }

                const scene = interaction.values[0];

                const modal = new ModalBuilder()
                    .setCustomId(`priority:location:${scene}`)
                    .setTitle("Priority Scene Location");

                const location = new TextInputBuilder()
                    .setCustomId("location")
                    .setLabel("Scene location")
                    .setPlaceholder("Enter the scene location")
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(150)
                    .setRequired(true);

                modal.addComponents(row(location));

                return interaction.showModal(modal);
            }
        }

        if (interaction.isButton()) {
            if (interaction.customId === "welcome:support") {
                const panel = cfg.panelChannel
                    ? await client.channels.fetch(cfg.panelChannel).catch(() => null)
                    : null;

                return replyPrivate(
                    interaction,
                    panel
                        ? `Use the support panel in ${panel} to open a ticket.`
                        : "Please find the Texas Operations ticket panel in this server."
                );
            }

            if (interaction.customId === "ticket:claim") {
                return await claimTicket(interaction);
            }

            if (interaction.customId === "ticket:close") {
                return await closeTicket(interaction);
            }

            if (
                interaction.customId === "session:yes" ||
                interaction.customId === "session:no"
            ) {
                const state = sessionVotes.get(interaction.guildId);

                if (!state) {
                    return replyPrivate(
                        interaction,
                        "There is no active session vote."
                    );
                }

                state.votes.set(
                    interaction.user.id,
                    interaction.customId === "session:yes" ? "yes" : "no"
                );

                await replyPrivate(interaction, "Your vote has been recorded.");

                return await refreshVote(interaction.guildId);
            }
        }

        if (
            interaction.isModalSubmit() &&
            interaction.customId === "ticket:close:reason"
        ) {
            return await submitTicketClosure(interaction);
        }

        if (
            interaction.isModalSubmit() &&
            interaction.customId.startsWith("priority:location:")
        ) {
            if (!isStaff(interaction.member)) {
                return replyPrivate(
                    interaction,
                    "Only staff can activate priority scenes."
                );
            }

            const scene = interaction.customId.slice(
                "priority:location:".length
            );

            const location = clean(
                interaction.fields.getTextInputValue("location"),
                150
            );

            priorities.set(interaction.guildId, {
                scene,
                location,
                userId: interaction.user.id,
                startedAt: Date.now()
            });

            if (cfg.voiceChannel) {
                const voice = await client.channels
                    .fetch(cfg.voiceChannel)
                    .catch(() => null);

                if (voice && typeof voice.setStatus === "function") {
                    await voice.setStatus(
                        `🚨Priority Scene (${location})`
                    ).catch(error => {
                        console.error("Voice status update failed:", error.message);
                    });
                }
            }

            await sendLog(
                interaction.guild,
                `Priority activated: ${scene} at ${location} by ${interaction.user.tag}.`,
                true
            );

            await replyPrivate(
                interaction,
                `Priority activated: ${scene} at ${location}. Sending the voice announcement.`
            );

            const announcement = scene === "Vehicle Pursuit"
                ? `Attention all units. Vehicle pursuit active at ${location}. Approach with caution.`
                : `Attention all units. Hostage scene active at ${location}. Approach with caution.`;

            speakInVoiceChannel(announcement).catch(error => {
                console.error("[PRIORITY VOICE ANNOUNCEMENT FAILED]", error);
            });

            return;
        }
    } catch (error) {
        console.error("Interaction error:", error);

        if (interaction.isRepliable()) {
            const payload = {
                content: "Something went wrong. Check the terminal for details.",
                flags: EPHEMERAL
            };

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(payload).catch(() => {});
            } else {
                await interaction.reply(payload).catch(() => {});
            }
        }
    }
});

/* =========================================================
   STATUS WEBSITE
========================================================= */

const app = express();

app.disable("x-powered-by");
app.use(express.json());

app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Texas Operations</title>
<style>
body{margin:0;background:#111;color:#eee;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(600px,85%);padding:28px;background:#191919;border:1px solid #333;border-radius:14px}
p{color:#bbb;line-height:1.6}
code{color:#fff}
</style>
</head>
<body>
<main>
<h1>Texas Operations</h1>
<p>Discord bot status page.</p>
<p>Status: <strong>${client.isReady() ? "Online" : "Starting"}</strong></p>
<p>Health endpoint: <code>/health</code></p>
<p>Status API: <code>/api/status</code></p>
</main>
</body>
</html>`);
});

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        online: client.isReady(),
        uptime: Math.floor(process.uptime())
    });
});

app.get("/api/status", (_req, res) => {
    const voiceConnected = cfg.voiceChannel
        ? Boolean(client.guilds.cache.some(guild => {
            const connection = getVoiceConnection(guild.id);
            return connection?.joinConfig.channelId === cfg.voiceChannel;
        }))
        : false;

    res.json({
        name: BRAND,
        online: client.isReady(),
        botUser: client.user?.tag || null,
        guilds: client.guilds.cache.size,
        uptimeSeconds: Math.floor(process.uptime()),
        sessionActive: activeSessions.size > 0,
        voiceChannelConfigured: Boolean(cfg.voiceChannel),
        voiceConnected
    });
});

app.listen(cfg.port, "0.0.0.0", () => {
    console.log(`Status website listening on port ${cfg.port}`);
});

/* =========================================================
   ERROR HANDLING AND STARTUP
========================================================= */

process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
    console.error("Uncaught exception:", error);
});

(async () => {
    try {
        console.log("Starting Texas Operations...");

        await registerCommands();
        await client.login(cfg.token);
    } catch (error) {
        console.error("Failed to start Texas Operations:", error);
        process.exitCode = 1;
    }
})();
