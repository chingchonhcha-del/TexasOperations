require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
    Client, GatewayIntentBits, Partials, PermissionFlagsBits,
    ChannelType, MessageFlags, ContainerBuilder, TextDisplayBuilder,
    SeparatorBuilder, SeparatorSpacingSize, MediaGalleryBuilder,
    MediaGalleryItemBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
    TextInputBuilder, TextInputStyle, SlashCommandBuilder,
    REST, Routes, AttachmentBuilder, EmbedBuilder
} = require("discord.js");

const {
    joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus,
    entersState, createAudioPlayer, createAudioResource,
    AudioPlayerStatus, NoSubscriberBehavior, StreamType
} = require("@discordjs/voice");

const execFileAsync = promisify(execFile);

try {
    const ffmpegPath = require("ffmpeg-static");
    if (ffmpegPath) {
        process.env.PATH =
            `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH || ""}`;
    }
} catch (error) {
    console.warn("Could not load ffmpeg-static:", error.message);
}

/* CONFIGURATION */

const e = process.env;
const BRAND = "California Operations";

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
    managementRole: e.MANAGEMENT_ROLE_ID,

    generalCategory: e.GENERAL_SUPPORT_CATEGORY_ID || e.TICKET_CATEGORY_ID,
    reportCategory: e.REPORT_TICKETS_CATEGORY_ID,
    managementCategory: e.MANAGEMENT_SUPPORT_CATEGORY_ID,

    panelChannel: e.TICKET_PANEL_CHANNEL_ID,
    feedbackChannel: e.FEEDBACK_CHANNEL_ID,
    applicationChannel: e.APPLICATION_RESULTS_CHANNEL_ID,

    voiceChannel: e.VOICE_CHANNEL_ID,
    sessionChannel: e.SESSION_VOTE_CHANNEL_ID,

    serverName: e.SESSION_SERVER_NAME || BRAND,
    serverCode: e.SESSION_SERVER_CODE || "CSRPVOS",
    gameUrl: e.SESSION_GAME_URL || "",
    requiredVotes: Math.max(1, Number(e.SESSION_REQUIRED_VOTES || 5)),

    defaultBanner: e.DEFAULT_BANNER_URL || "",
    ticketBanner: e.TICKET_BANNER_URL || "",
    sessionBanner: e.SESSION_BANNER_URL || "",
    priorityBanner: e.PRIORITY_BANNER_URL || "",
    staffBanner: e.STAFF_BANNER_URL || "",
    applicationBanner: e.APPLICATION_BANNER_URL || "",
    feedbackBanner: e.FEEDBACK_BANNER_URL || "",
    moderationBanner: e.MODERATION_BANNER_URL || "",
    promotionBanner: e.PROMOTION_BANNER_URL || "",
    infractionBanner: e.INFRACTION_BANNER_URL || "",
    logBanner: e.LOG_BANNER_URL || "",

    priorityPanelChannel: e.PRIORITY_PANEL_CHANNEL_ID || "",
    priorityStaffChannel: e.PRIORITY_STAFF_CHANNEL_ID || "",
    priorityStaffRole: e.PRIORITY_STAFF_ROLE_ID || e.STAFF_ROLE_ID || "",
    priorityAnnouncementChannel: e.PRIORITY_ANNOUNCEMENT_CHANNEL_ID || "",
    priorityRestrictedZonesUrl: e.PRIORITY_RESTRICTED_ZONES_URL || "",
    priorityDurationMinutes: Math.max(1, Number(e.PRIORITY_DURATION_MINUTES || 30)),
    priorityMaxQueue: Math.max(1, Number(e.PRIORITY_MAX_QUEUE || 10)),

    port: Number(e.PORT || 3000)
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
    partials: [Partials.Message, Partials.Channel, Partials.User]
});

const tickets = new Map();
const claims = new Map();
const priorities = new Map();
const priorityRequests = new Map();
const priorityTimers = new Map();
const warnings = new Map();
const sessionVotes = new Map();
const activeSessions = new Map();

const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;

/* AUDIO AND WINDOWS SPEECH */

const speechPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
});

const speechQueue = [];
let speechQueueRunning = false;
let voiceJoinInProgress = false;

speechPlayer.on("error", error =>
    console.error("[VOICE] Audio player error:", error.message)
);

async function generateWindowsSpeech(text) {
    const spokenText = String(text || "").trim();

    if (!spokenText) throw new Error("The speech announcement is empty.");
    if (process.platform !== "win32") {
        throw new Error("Windows speech requires the bot to run on Windows.");
    }

    const audioPath = path.join(
        os.tmpdir(),
        `california-speech-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
    );

    const encodedText = Buffer.from(spokenText, "utf8").toString("base64");
    const encodedPath = Buffer.from(audioPath, "utf8").toString("base64");

    const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${encodedText}"))
$outputPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${encodedPath}"))
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.Rate = 0
    $synth.Volume = 100
    $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
    $preferred = @("Microsoft David Desktop", "Microsoft Mark", "Microsoft Guy Online", "Microsoft Ryan Online")
    $selected = $null
    foreach ($name in $preferred) {
        $match = $voices | Where-Object { $_.VoiceInfo.Name -eq $name } | Select-Object -First 1
        if ($match) { $selected = $match; break }
    }
    if (-not $selected) {
        $selected = $voices | Where-Object { $_.VoiceInfo.Gender.ToString() -eq "Male" } | Select-Object -First 1
    }
    if ($selected) {
        $synth.SelectVoice($selected.VoiceInfo.Name)
        Write-Output ("Selected voice: " + $selected.VoiceInfo.Name)
    } elseif ($voices.Count -gt 0) {
        $synth.SelectVoice($voices[0].VoiceInfo.Name)
    } else {
        throw "No enabled Windows speech voices are installed."
    }
    $synth.SetOutputToWaveFile($outputPath)
    $synth.Speak($text)
} finally {
    $synth.Dispose()
}`;

    const encodedScript = Buffer.from(script, "utf16le").toString("base64");

    try {
        await execFileAsync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-EncodedCommand", encodedScript
        ], {
            windowsHide: true,
            timeout: 60000,
            maxBuffer: 1024 * 1024
        });

        const file = await fs.stat(audioPath);
        if (!file.size) throw new Error("Windows generated an empty audio file.");
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
            error ? reject(error) : resolve();
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
    if (!cfg.voiceChannel) throw new Error("VOICE_CHANNEL_ID is missing.");

    const channel = await client.channels.fetch(cfg.voiceChannel).catch(() => null);
    if (!channel) throw new Error("Configured voice channel was not found.");

    if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
    ) {
        throw new Error("VOICE_CHANNEL_ID must be a voice or stage channel.");
    }

    let connection = getVoiceConnection(channel.guild.id);

    if (!connection || connection.joinConfig.channelId !== channel.id) {
        await joinConfiguredVoiceChannel();
        connection = getVoiceConnection(channel.guild.id);
    }

    if (!connection) throw new Error("Bot is not connected to the voice channel.");

    await entersState(connection, VoiceConnectionStatus.Ready, 30000);

    const me = await channel.guild.members.fetchMe();
    const permissions = channel.permissionsFor(me);

    if (!permissions?.has(PermissionFlagsBits.Connect)) {
        throw new Error("Bot needs Connect permission in the voice channel.");
    }
    if (!permissions?.has(PermissionFlagsBits.Speak)) {
        throw new Error("Bot needs Speak permission in the voice channel.");
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

        const finished = waitForPlayerIdle(speechPlayer);
        speechPlayer.play(resource);
        await finished;
    } finally {
        await fs.unlink(audioPath).catch(() => {});
    }
}

async function processSpeechQueue() {
    if (speechQueueRunning) return;
    speechQueueRunning = true;

    try {
        while (speechQueue.length) {
            const item = speechQueue.shift();
            try {
                await playSpeech(item.text);
                item.resolve?.();
            } catch (error) {
                console.error("[SPEECH]", error.message);
                item.reject?.(error);
            }
        }
    } finally {
        speechQueueRunning = false;
        if (speechQueue.length) void processSpeechQueue();
    }
}

function speakInVoiceChannel(text) {
    return new Promise((resolve, reject) => {
        speechQueue.push({ text: String(text), resolve, reject });
        void processSpeechQueue();
    });
}

/* GENERAL HELPERS AND BANNER SYSTEM */

function validImageUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
    } catch {
        return null;
    }
}

function bannerForTitle(title) {
    const value = String(title || "").toLowerCase();

    if (value.includes("priority")) return cfg.priorityBanner;
    if (value.includes("session")) return cfg.sessionBanner;
    if (value.includes("ticket") || value.includes("support")) return cfg.ticketBanner;
    if (value.includes("application")) return cfg.applicationBanner;
    if (value.includes("feedback")) return cfg.feedbackBanner;
    if (value.includes("promotion")) return cfg.promotionBanner || cfg.staffBanner;
    if (value.includes("infraction")) return cfg.infractionBanner || cfg.staffBanner;
    if (
        value.includes("moderation") || value.includes("warn") ||
        value.includes("ban") || value.includes("kick") ||
        value.includes("timeout") || value.includes("purge")
    ) return cfg.moderationBanner;
    if (value.includes("log")) return cfg.logBanner;

    return cfg.defaultBanner;
}

function makeV2(title, body, rows = [], explicitBanner = null) {
    const container = new ContainerBuilder();
    const banner = validImageUrl(explicitBanner || bannerForTitle(title));

    if (banner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(banner)
            )
        );
    }

    container
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`# ${title}`)
        )
        .addSeparatorComponents(
            new SeparatorBuilder()
                .setSpacing(SeparatorSpacingSize.Small)
                .setDivider(true)
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(body || "No additional information.")
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

function isPriorityStaff(member) {
    return Boolean(
        isStaff(member) ||
        (cfg.priorityStaffRole && member?.roles?.cache?.has(cfg.priorityStaffRole))
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
        staff ? (cfg.staffLogChannel || cfg.logChannel) : cfg.logChannel
    );
    if (!channel) return;

    await channel.send(
        makeV2(staff ? "Staff Log" : "Server Log", content)
    ).catch(console.error);
}

/* WELCOME MESSAGE */

function welcomeMessage(member) {
    const count = member.guild.memberCount;
    const emoji = cfg.welcomeEmoji?.trim() || "";

    const countButton = new ButtonBuilder()
        .setCustomId("welcome:membercount")
        .setLabel(`Members: ${count}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

    const supportButton = cfg.panelChannel
        ? new ButtonBuilder()
            .setLabel("Support")
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${member.guild.id}/${cfg.panelChannel}`)
        : new ButtonBuilder()
            .setCustomId("welcome:support")
            .setLabel("Support")
            .setStyle(ButtonStyle.Secondary);

    return {
        content: `${emoji ? `${emoji} ` : ""}Welcome ${member} to **California Operations**, you're our ${count} member!`,
        components: [row(countButton, supportButton)],
        allowedMentions: { users: [member.id] }
    };
}

/* VOICE CONNECTION */

async function joinConfiguredVoiceChannel() {
    if (voiceJoinInProgress) return getVoiceConnection(cfg.guildId);
    if (!cfg.voiceChannel) return;

    voiceJoinInProgress = true;

    try {
        const channel = await client.channels.fetch(cfg.voiceChannel).catch(() => null);
        if (!channel) throw new Error("Voice channel not found.");

        if (
            channel.type !== ChannelType.GuildVoice &&
            channel.type !== ChannelType.GuildStageVoice
        ) {
            throw new Error("VOICE_CHANNEL_ID must be a voice or stage channel.");
        }

        const guild = channel.guild;
        const me = await guild.members.fetchMe();
        const permissions = channel.permissionsFor(me);

        if (!permissions?.has(PermissionFlagsBits.Connect)) {
            throw new Error("Bot is missing Connect permission in voice.");
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

        if (connection) connection.destroy();

        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        connection.on("error", error =>
            console.error("Voice connection error:", error.message)
        );

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000)
                ]);
            } catch {
                try { connection.destroy(); } catch {}
                setTimeout(() => {
                    joinConfiguredVoiceChannel().catch(console.error);
                }, 5000);
            }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 30000);
        connection.subscribe(speechPlayer);
        console.log(`Joined voice channel: ${channel.name}`);
        return connection;
    } catch (error) {
        console.error("Voice connection failed:", error.message);
    } finally {
        voiceJoinInProgress = false;
    }
}

/* SESSION SYSTEM */

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

    const channel = await client.channels.fetch(state.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const message = await channel.messages.fetch(state.messageId).catch(() => null);
    if (message) await message.edit(votePanel(state)).catch(console.error);

    const counts = voteCounts(guildId);

    if (counts.yes >= state.required && !state.passed) {
        state.passed = true;

        await channel.send(sessionAnnouncement(
            "Session Vote Passed",
            `The vote reached ${counts.yes}/${state.required} yes votes. Staff can now start the session.`,
            true
        )).catch(console.error);

        await sendLog(channel.guild,
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
        throw new Error("Configure SESSION_VOTE_CHANNEL_ID or set a system channel.");
    }

    activeSessions.set(guild.id, {
        startedAt: Date.now(),
        startedBy: user.id
    });

    await destination.send(sessionAnnouncement(
        "Session Started",
        "The roleplay session is now open. Join the server using the information below.",
        true
    ));

    const oldVote = sessionVotes.get(guild.id);
    sessionVotes.delete(guild.id);

    if (oldVote) {
        const voteChannel = await client.channels.fetch(oldVote.channelId).catch(() => null);
        if (voteChannel?.isTextBased()) {
            await voteChannel.send(makeV2(
                "Session Vote Ended",
                `A staff member started the session.\n\n${sessionInfo()}`
            )).catch(() => {});
        }
    }

    await sendLog(guild, `Session started by ${user.tag || user.username}.`, true);
}

async function shutdownSession(guild, user) {
    activeSessions.delete(guild.id);
    sessionVotes.delete(guild.id);

    const channel = cfg.sessionChannel
        ? channelById(guild, cfg.sessionChannel)
        : null;
    const destination = channel || guild.systemChannel;

    if (!destination) {
        throw new Error("Configure SESSION_VOTE_CHANNEL_ID or set a system channel.");
    }

    await destination.send(sessionAnnouncement(
        "Session Shutdown",
        "The session is now closed. Thank you to everyone who attended."
    ));

    await sendLog(guild, `Session shutdown by ${user.tag || user.username}.`, true);
}

/* TICKETS */

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
        "California Operations | Support Tickets",
        "Choose a department below to open a private ticket.\n\n" +
        "**General Support** — General questions and help.\n" +
        "**Report Tickets** — Report a player or incident.\n" +
        "**Management Support** — Management matters.",
        [row(
            new StringSelectMenuBuilder()
                .setCustomId("ticket:create")
                .setPlaceholder("Choose a ticket category")
                .addOptions(
                    { label: "General Support", value: "general" },
                    { label: "Report Tickets", value: "report" },
                    { label: "Management Support", value: "management" }
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
        if (key.startsWith(`${guildId}:`) && id === channelId) return key;
    }

    const channel = client.channels.cache.get(channelId);

    if (channel?.topic?.startsWith("sunshine-ticket:")) {
        const parts = channel.topic.split(":");
        if (parts.length >= 4 && parts[1] === guildId) {
            return `${parts[1]}:${parts[2]}:${parts[3]}`;
        }
    }
    return null;
}

async function createTicket(interaction, type, inquiry = "No inquiry provided.") {
    const guild = interaction.guild;
    const user = interaction.user;
    const info = ticketTypes[type];

    if (!info) return replyPrivate(interaction, "Unknown ticket type.");

    const key = `${guild.id}:${user.id}:${type}`;
    const oldId = tickets.get(key);
    const oldChannel = oldId ? guild.channels.cache.get(oldId) : null;

    if (oldChannel) {
        return replyPrivate(interaction, `You already have a ticket: ${oldChannel}`);
    }

    const existing = guild.channels.cache.find(channel =>
        channel.topic === `sunshine-ticket:${guild.id}:${user.id}:${type}`
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
            topic: `sunshine-ticket:${guild.id}:${user.id}:${type}`,
            permissionOverwrites: overwrites,
            reason: `${info.label} ticket opened by ${user.tag}`
        });

        tickets.set(key, channel.id);

        await channel.send(makeV2(
            info.label,
            `Welcome ${user}!\n\nPlease explain your request and include any relevant details.\n\n` +
            `**Opened by:** ${user.tag}\n**Department:** ${info.label}\n` +
            `**Inquiry:**\n${clean(inquiry, 1500)}`,
            [row(
                button("ticket:claim", "Claim Ticket"),
                button("ticket:close", "Close Ticket", ButtonStyle.Danger)
            )]
        ));

        await replyPrivate(interaction, `Your ticket has been created: ${channel}`);

        await sendLog(
            guild,
            `Ticket created: ${channel}\nDepartment: ${info.label}\nOpened by: ${user.tag} (${user.id})`,
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
    await sendLog(interaction.guild, `${interaction.user.tag} claimed ${interaction.channel}.`, true);
}

async function makeTicketTranscript(channel, closingUser, reason) {
    const messages = [];
    let before;

    for (let page = 0; page < 10; page++) {
        const batch = await channel.messages.fetch({
            limit: 100,
            ...(before ? { before } : {})
        }).catch(error => {
            console.error("Transcript fetch failed:", error.message);
            return null;
        });

        if (!batch?.size) break;
        messages.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
    }

    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const lines = [
        "CALIFORNIA OPERATIONS - TICKET TRANSCRIPT",
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
        if (message.embeds?.length) content += `\n[Embeds: ${message.embeds.length}]`;
        if (message.attachments?.size) {
            content += "\nAttachments:\n" +
                message.attachments.map(a => a.url).join("\n");
        }
        if (message.stickers?.size) {
            content += "\n[Stickers: " +
                message.stickers.map(s => s.name).join(", ") + "]";
        }

        lines.push(`[${timestamp}] ${author}`);
        lines.push(content.trim() || "[No text content]");
        lines.push("-".repeat(50));
    }

    return Buffer.from(lines.join("\n"), "utf8");
}

async function closeTicketChannel(channel, closingUser, reason) {
    const key = findTicketKey(channel.guild.id, channel.id);
    if (!key) throw new Error("This is not a recognized ticket channel.");

    const ownerId = key.split(":")[1];
    const closureReason = clean(reason, 1000);
    const transcript = await makeTicketTranscript(channel, closingUser, closureReason);

    const attachment = new AttachmentBuilder(transcript, {
        name: `ticket-${channel.id}-transcript.txt`,
        description: "Ticket transcript"
    });

    let dmSent = false;

    try {
        const owner = await client.users.fetch(ownerId);
        await owner.send({
            content:
                `Your ticket **#${channel.name}** has been closed.\n` +
                `**Closed by:** ${closingUser.tag || closingUser.username}\n` +
                `**Reason:** ${closureReason}\n\nYour transcript is attached.`,
            files: [attachment],
            allowedMentions: { parse: [] }
        });
        dmSent = true;
    } catch (error) {
        console.error("Could not DM ticket transcript:", error.message);
    }

    await sendLog(
        channel.guild,
        `**Ticket closed:** #${channel.name}\n**Ticket owner:** <@${ownerId}> (${ownerId})\n` +
        `**Closed by:** ${closingUser.tag || closingUser.username} (${closingUser.id})\n` +
        `**Reason:** ${closureReason}\n**Transcript DM:** ${dmSent ? "Sent" : "Could not deliver"}`,
        true
    );

    tickets.delete(key);
    claims.delete(channel.id);

    await channel.send(makeV2(
        "Ticket Closed",
        `**Closed by:** ${closingUser}\n**Reason:** ${closureReason}\n` +
        `**Transcript DM:** ${dmSent ? "Sent to the ticket owner." : "Could not DM the owner."}\n\n` +
        "This channel will be deleted shortly."
    )).catch(() => {});

    setTimeout(() => {
        channel.delete(`Ticket closed by ${closingUser.tag || closingUser.username}`)
            .catch(console.error);
    }, 3000);

    return { dmSent };
}

async function closeTicket(interaction) {
    const key = findTicketKey(interaction.guildId, interaction.channelId);
    if (!key) return replyPrivate(interaction, "This is not a recognized ticket.");

    const ownerId = key.split(":")[1];

    if (ownerId !== interaction.user.id && !isStaff(interaction.member)) {
        return replyPrivate(interaction, "Only the ticket owner or staff can close this ticket.");
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

    if (!key) return replyPrivate(interaction, "This ticket is no longer recognized.");

    const ownerId = key.split(":")[1];

    if (ownerId !== interaction.user.id && !isStaff(interaction.member)) {
        return replyPrivate(interaction, "Only the ticket owner or staff can close this ticket.");
    }

    const reason = clean(interaction.fields.getTextInputValue("reason"), 1000);
    await replyPrivate(interaction, "Closing ticket and generating transcript...");

    try {
        const result = await closeTicketChannel(channel, interaction.user, reason);

        if (!result.dmSent) {
            await interaction.followUp({
                content: "Ticket closed, but the transcript DM could not be delivered.",
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

/* PRIORITY SYSTEM - PUBLIC REQUEST PANEL AND STAFF QUEUE */

function priorityPublicPanel() {
    const restrictedText = cfg.priorityRestrictedZonesUrl
        ? `[Restricted Roleplay Zones](${cfg.priorityRestrictedZonesUrl})`
        : "**Restricted Roleplay Zones**";

    return makeV2(
        "Priorities & Permissions",
        "Plan your scene, request staff approval, and follow your place in the priority queue. " +
        "Use **Request Priority** to get started; we’ll DM you when it’s your turn. " +
        `Before choosing a location, review ${restrictedText}.`,
        [row(
            button("priority:request", "Request Priority", ButtonStyle.Primary)
        )]
    );
}

function priorityPanel() {
    return makeV2(
        "Priority Scene Control",
        "Staff controls for manually activating a priority scene. Choose a scene type, then enter its location.",
        [row(
            new StringSelectMenuBuilder()
                .setCustomId("priority:choose")
                .setPlaceholder("Choose a priority scene")
                .addOptions(
                    { label: "Vehicle Pursuit", value: "Vehicle Pursuit" },
                    { label: "Hostage Scene", value: "Hostage Scene" },
                    { label: "Bank Robbery", value: "Bank Robbery" },
                    { label: "Jewelry Store Robbery", value: "Jewelry Store Robbery" }
                )
        )]
    );
}

function priorityQueuePosition(request) {
    const approved = [...priorityRequests.values()]
        .filter(item =>
            item.guildId === request.guildId &&
            item.status === "Approved"
        )
        .sort((a, b) => a.approvedAt - b.approvedAt);

    return approved.findIndex(item => item.id === request.id) + 1;
}

function priorityRequestCard(request) {
    const position = request.status === "Approved"
        ? priorityQueuePosition(request)
        : null;

    const body =
        `**Request ID:** ${request.id}\n` +
        `**Requester:** <@${request.userId}>\n` +
        `**Scene:** ${request.scene}\n` +
        `**Location:** ${request.location}\n` +
        `**Details:** ${request.details}\n\n` +
        `**Status:** ${request.status}` +
        (position ? `\n**Queue position:** ${position}` : "");

    let controls = [];

    if (request.status === "Pending") {
        controls = [
            button(`priority:approve:${request.id}`, "Approve", ButtonStyle.Success),
            button(`priority:deny:${request.id}`, "Deny", ButtonStyle.Danger)
        ];
    } else if (request.status === "Approved") {
        controls = [
            button(`priority:start:${request.id}`, "Start Scene", ButtonStyle.Primary),
            button(`priority:deny:${request.id}`, "Cancel Request", ButtonStyle.Danger)
        ];
    }

    return makeV2(
        "Priority Request",
        body,
        controls.length ? [row(...controls)] : []
    );
}

async function updatePriorityRequestMessage(request) {
    if (!request.staffChannelId || !request.staffMessageId) return;

    const channel = await client.channels.fetch(request.staffChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const message = await channel.messages.fetch(request.staffMessageId).catch(() => null);
    if (message) {
        await message.edit(priorityRequestCard(request)).catch(console.error);
    }
}

async function dmPriorityUser(request, content) {
    try {
        const user = await client.users.fetch(request.userId);
        await user.send({
            content,
            allowedMentions: { parse: [] }
        });
    } catch (error) {
        console.warn(`Could not DM priority requester ${request.userId}:`, error.message);
    }
}

async function submitPriorityRequest(interaction) {
    const staffChannel = channelById(
        interaction.guild,
        cfg.priorityStaffChannel
    );

    if (!staffChannel) {
        return replyPrivate(
            interaction,
            "Priority staff channel is not configured. Ask an administrator to set PRIORITY_STAFF_CHANNEL_ID."
        );
    }

    const existing = [...priorityRequests.values()].find(request =>
        request.guildId === interaction.guildId &&
        request.userId === interaction.user.id &&
        ["Pending", "Approved"].includes(request.status)
    );

    if (existing) {
        return replyPrivate(
            interaction,
            `You already have an active priority request. Current status: ${existing.status}.`
        );
    }

    const pendingCount = [...priorityRequests.values()].filter(request =>
        request.guildId === interaction.guildId &&
        ["Pending", "Approved"].includes(request.status)
    ).length;

    if (pendingCount >= cfg.priorityMaxQueue) {
        return replyPrivate(interaction, "The priority request queue is currently full.");
    }

    const request = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        scene: clean(interaction.fields.getTextInputValue("scene"), 100),
        location: clean(interaction.fields.getTextInputValue("location"), 150),
        details: clean(interaction.fields.getTextInputValue("details"), 800),
        status: "Pending",
        createdAt: Date.now(),
        approvedAt: null,
        staffChannelId: staffChannel.id,
        staffMessageId: null
    };

    priorityRequests.set(request.id, request);

    try {
        const payload = priorityRequestCard(request);

       if (cfg.priorityStaffRole) {
    payload.components[0].addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`<@&${cfg.priorityStaffRole}>`)
    );
    payload.allowedMentions = {
        parse: [],
        roles: [cfg.priorityStaffRole]
    };
}
        

        const message = await staffChannel.send(payload);
        request.staffMessageId = message.id;

        await replyPrivate(
            interaction,
            "Your priority request has been submitted. Staff will review it and DM you with an update."
        );

        await sendLog(
            interaction.guild,
            `Priority request ${request.id} submitted by ${interaction.user.tag}. Scene: ${request.scene}. Location: ${request.location}.`,
            true
        );
    } catch (error) {
        priorityRequests.delete(request.id);
        console.error("Priority request submission failed:", error);
        await replyPrivate(interaction, "Could not submit your request. Please contact staff.");
    }
}

async function approvePriorityRequest(interaction, request) {
    if (!isPriorityStaff(interaction.member)) {
        return replyPrivate(interaction, "Only authorized staff can approve priority requests.");
    }

    if (request.status !== "Pending") {
        return replyPrivate(interaction, "This request has already been reviewed.");
    }

    request.status = "Approved";
    request.approvedAt = Date.now();

    await updatePriorityRequestMessage(request);

    const position = priorityQueuePosition(request);

    await dmPriorityUser(
        request,
        `Your priority request for **${request.scene}** at **${request.location}** has been approved.\n` +
        `Your current queue position is **${position}**. Staff will notify you when the scene is ready to start.`
    );

    await replyPrivate(interaction, `Request approved. Queue position: ${position}.`);

    await sendLog(
        interaction.guild,
        `Priority request ${request.id} approved by ${interaction.user.tag}. Queue position: ${position}.`,
        true
    );
}

async function denyPriorityRequest(interaction, request) {
    if (!isPriorityStaff(interaction.member)) {
        return replyPrivate(interaction, "Only authorized staff can deny priority requests.");
    }

    if (!["Pending", "Approved"].includes(request.status)) {
        return replyPrivate(interaction, "This request is already closed.");
    }

    request.status = "Denied";
    request.deniedBy = interaction.user.id;

    await updatePriorityRequestMessage(request);

    await dmPriorityUser(
        request,
        `Your priority request for **${request.scene}** at **${request.location}** was not approved or has been cancelled. Please contact staff if you need more information.`
    );

    await replyPrivate(interaction, "Priority request denied/cancelled.");

    await sendLog(
        interaction.guild,
        `Priority request ${request.id} denied/cancelled by ${interaction.user.tag}.`,
        true
    );
}

async function announcePriorityStart(guild, request) {
    const channel =
        channelById(guild, cfg.priorityAnnouncementChannel) ||
        channelById(guild, cfg.priorityPanelChannel) ||
        guild.systemChannel;

    if (!channel) return;

    await channel.send(makeV2(
        "Priority Scene Started",
        `A priority scene has been started at **${request.location}**.\n\n` +
        `**Scene:** ${request.scene}\n` +
        `**Requested by:** <@${request.userId}>\n` +
        `**Duration:** ${cfg.priorityDurationMinutes} minutes\n\n` +
        "All units should follow server priority and roleplay procedures."
    )).catch(console.error);
}

async function startPriorityRequest(interaction, request) {
    if (!isPriorityStaff(interaction.member)) {
        return replyPrivate(interaction, "Only authorized staff can start priority scenes.");
    }

    if (request.status !== "Approved") {
        return replyPrivate(interaction, "This request must be approved before it can start.");
    }

    const active = priorities.get(interaction.guildId);

    if (active) {
        return replyPrivate(
            interaction,
            `Another priority is already active: ${active.scene} at ${active.location}.`
        );
    }

    const nextApproved = [...priorityRequests.values()]
        .filter(item =>
            item.guildId === interaction.guildId &&
            item.status === "Approved"
        )
        .sort((a, b) => a.approvedAt - b.approvedAt)[0];

    if (nextApproved && nextApproved.id !== request.id) {
        return replyPrivate(
            interaction,
            `Another request is ahead in the queue: ${nextApproved.scene} at ${nextApproved.location}.`
        );
    }

    request.status = "Active";
    request.startedAt = Date.now();

    priorities.set(interaction.guildId, {
        scene: request.scene,
        location: request.location,
        userId: interaction.user.id,
        requesterId: request.userId,
        requestId: request.id,
        startedAt: Date.now()
    });

    if (cfg.voiceChannel) {
        const voice = await client.channels.fetch(cfg.voiceChannel).catch(() => null);
        if (voice && typeof voice.setStatus === "function") {
            await voice.setStatus(`Priority: ${request.scene} - ${request.location}`)
                .catch(error => console.error("Voice status update failed:", error.message));
        }
    }

    await announcePriorityStart(interaction.guild, request);
    await updatePriorityRequestMessage(request);

    await dmPriorityUser(
        request,
        `Your priority scene is now starting at **${request.location}**. Please follow staff instructions.`
    );

    const announcement =
        `Attention all units. A ${request.scene} priority scene has started at ${request.location}. ` +
        "All units should approach with caution and follow staff instructions.";

    speakInVoiceChannel(announcement).catch(error =>
        console.error("[PRIORITY VOICE ANNOUNCEMENT FAILED]", error)
    );

    const timer = setTimeout(async () => {
        try {
            await endPriority(interaction.guild, client.user, true);
        } catch (error) {
            console.error("Automatic priority end failed:", error);
        }
    }, cfg.priorityDurationMinutes * 60 * 1000);

    priorityTimers.set(interaction.guildId, timer);

    await replyPrivate(
        interaction,
        `Priority scene started. It will automatically end in ${cfg.priorityDurationMinutes} minutes.`
    );

    await sendLog(
        interaction.guild,
        `Priority ${request.id} started by ${interaction.user.tag}: ${request.scene} at ${request.location}.`,
        true
    );
}

async function endPriority(guild, user, automatic = false) {
    const previous = priorities.get(guild.id);
    const timer = priorityTimers.get(guild.id);

    if (timer) clearTimeout(timer);
    priorityTimers.delete(guild.id);
    priorities.delete(guild.id);

    if (previous?.requestId) {
        const request = priorityRequests.get(previous.requestId);
        if (request) {
            request.status = "Completed";
            request.completedAt = Date.now();
            await updatePriorityRequestMessage(request);
            await dmPriorityUser(
                request,
                `Your priority scene at **${request.location}** has ended. Thank you for coordinating with staff.`
            );
        }
    }

    if (cfg.voiceChannel) {
        const voice = await client.channels.fetch(cfg.voiceChannel).catch(() => null);
        if (voice && typeof voice.setStatus === "function") {
            await voice.setStatus("").catch(error =>
                console.error("Could not clear voice status:", error.message)
            );
        }
    }

    const announcementChannel =
        channelById(guild, cfg.priorityAnnouncementChannel) ||
        channelById(guild, cfg.priorityPanelChannel);

    if (previous && announcementChannel) {
        await announcementChannel.send(makeV2(
            "Priority Scene Ended",
            `The priority scene **${previous.scene}** at **${previous.location}** has ended.`
        )).catch(() => {});
    }

    await sendLog(
        guild,
        `Priority ended ${automatic ? "automatically" : "manually"} by ${user.tag || user.username}.` +
        (previous ? ` Previous scene: ${previous.scene} at ${previous.location}.` : ""),
        true
    );
}

/* SLASH COMMANDS */

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
    new SlashCommandBuilder().setName("help").setDescription("Show bot commands"),
    new SlashCommandBuilder().setName("ticketpanel").setDescription("Send the ticket panel"),
    new SlashCommandBuilder().setName("priority").setDescription("Open staff priority controls"),
    new SlashCommandBuilder().setName("priority-panel").setDescription("Publish the public priority request panel"),
    new SlashCommandBuilder().setName("endpriority").setDescription("End the active priority"),
    sessionCommand,

    new SlashCommandBuilder()
        .setName("feedback").setDescription("Submit feedback")
        .addIntegerOption(o => o.setName("rating").setDescription("Rating from 0 to 5").setMinValue(0).setMaxValue(5).setRequired(true))
        .addStringOption(o => o.setName("message").setDescription("Feedback text").setRequired(true).setMaxLength(1000)),

    new SlashCommandBuilder()
        .setName("appresult").setDescription("Publish an application result")
        .addUserOption(o => o.setName("user").setDescription("Applicant").setRequired(true))
        .addStringOption(o => o.setName("result").setDescription("Result").setRequired(true)
            .addChoices({ name: "Pass", value: "Pass" }, { name: "Fail", value: "Fail" }))
        .addIntegerOption(o => o.setName("score").setDescription("Score out of 100").setMinValue(0).setMaxValue(100))
        .addStringOption(o => o.setName("notes").setDescription("Notes").setMaxLength(1000)),

    new SlashCommandBuilder()
        .setName("promotion").setDescription("Announce a promotion")
        .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
        .addStringOption(o => o.setName("rank").setDescription("New rank").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("infraction").setDescription("Record an infraction")
        .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
        .addStringOption(o => o.setName("type").setDescription("Infraction type").setRequired(true)
            .addChoices(
                { name: "Warning", value: "Warning" },
                { name: "Strike", value: "Strike" },
                { name: "Demotion", value: "Demotion" },
                { name: "Termination", value: "Termination" }
            ))
        .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),

    new SlashCommandBuilder()
        .setName("say").setDescription("Send a plain-text message")
        .addStringOption(o => o.setName("message").setDescription("Message to send").setRequired(true).setMaxLength(2000)),

    new SlashCommandBuilder()
        .setName("mediapost").setDescription("Publish a photo/media post with credit")
        .addAttachmentOption(o => o.setName("file").setDescription("Main image or file").setRequired(true))
        .addAttachmentOption(o => o.setName("file2").setDescription("Additional image or file"))
        .addAttachmentOption(o => o.setName("file3").setDescription("Additional image or file"))
        .addAttachmentOption(o => o.setName("file4").setDescription("Additional image or file"))
        .addStringOption(o => o.setName("caption").setDescription("Optional caption").setMaxLength(1000))
        .addUserOption(o => o.setName("photo_by").setDescription("Person to credit in the post")),

    new SlashCommandBuilder()
        .setName("kick").setDescription("Kick a member")
        .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("ban").setDescription("Ban a member")
        .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("unban").setDescription("Unban a user by ID")
        .addStringOption(o => o.setName("userid").setDescription("User ID").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("timeout").setDescription("Timeout a member")
        .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
        .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes").setMinValue(1).setMaxValue(40320).setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("untimeout").setDescription("Remove a timeout")
        .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason")),

    new SlashCommandBuilder()
        .setName("purge").setDescription("Delete messages")
        .addIntegerOption(o => o.setName("amount").setDescription("Number from 1 to 100").setMinValue(1).setMaxValue(100).setRequired(true)),

    new SlashCommandBuilder()
        .setName("warn").setDescription("Warn a member")
        .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),

    new SlashCommandBuilder()
        .setName("dm").setDescription("Send a direct message to a user")
        .addUserOption(o => o.setName("user").setDescription("Recipient").setRequired(true))
        .addStringOption(o => o.setName("message").setDescription("Message").setRequired(true).setMaxLength(2000))
].map(command => command.toJSON());

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(cfg.token);
    const route = cfg.guildId
        ? Routes.applicationGuildCommands(cfg.clientId, cfg.guildId)
        : Routes.applicationCommands(cfg.clientId);

    await rest.put(route, { body: commands });
    console.log(`Registered ${commands.length} slash commands.`);
}

/* COMMAND HANDLER */

async function executeCommand(ctx, name, args = {}) {
    const interaction = ctx.isChatInputCommand();
    const guild = ctx.guild;
    const user = ctx.user || ctx.author;

    const get = (key, type = "string") => {
        if (!interaction) return args[key] ?? null;
        if (type === "user") return ctx.options.getUser(key);
        if (type === "attachment") return ctx.options.getAttachment(key);
        if (type === "integer") return ctx.options.getInteger(key);
        return ctx.options.getString(key);
    };

    const reply = message =>
        interaction ? replyPrivate(ctx, message) : ctx.reply(message);

    switch (name) {
        case "help": {
            const payload = makeV2(
                "California Operations Commands",
                "**Sessions:** `/session vote`, `/session start`, `/session shutdown`\n" +
                "**Tickets:** `/ticketpanel`\n" +
                "**Priority:** `/priority-panel`, `/priority`, `/endpriority`\n" +
                "**Staff:** `/promotion`, `/infraction`, `/appresult`\n" +
                "**Moderation:** `/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/purge`, `/warn`\n" +
                "**Other:** `/feedback`, `/say`, `/dm`, `/mediapost`"
            );

            return interaction
                ? ctx.reply({ ...payload, flags: V2 | EPHEMERAL })
                : ctx.reply(payload);
        }

        case "session": {
            if (!await requireStaff(ctx)) return;
            const sub = interaction ? ctx.options.getSubcommand() : args.subcommand;

            if (sub === "vote") {
                const required = get("required_votes", "integer") || cfg.requiredVotes;
                const channel = cfg.sessionChannel
                    ? channelById(guild, cfg.sessionChannel)
                    : ctx.channel;

                if (!channel) return reply("The session vote channel is not configured.");

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

                await sendLog(guild,
                    `Session vote started by ${user.tag}. Required yes votes: ${required}.`,
                    true
                );

                return reply(`Session vote started in ${channel}; ${required} yes votes are required.`);
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

        case "priority-panel": {
            if (!await requireStaff(ctx)) return;

            const destination = cfg.priorityPanelChannel
                ? channelById(guild, cfg.priorityPanelChannel)
                : ctx.channel;

            if (!destination) {
                return reply("Priority panel channel is missing or invalid.");
            }

            await destination.send(priorityPublicPanel());
            return reply(`Public priority request panel sent in ${destination}.`);
        }

        case "priority":
            if (!await requireStaff(ctx)) return;
            return interaction
                ? ctx.reply({ ...priorityPanel(), flags: V2 | EPHEMERAL })
                : ctx.reply(priorityPanel());

        case "endpriority":
            if (!await requireStaff(ctx)) return;
            await endPriority(guild, user, false);
            return reply("Priority ended.");

        case "feedback": {
            const destination = channelById(guild, cfg.feedbackChannel);
            if (!destination) return reply("Feedback channel is not configured.");

            await destination.send(makeV2(
                "California Operations Feedback",
                `**From:** ${user.tag || user.username}\n` +
                `**Rating:** ${get("rating", "integer")}/5\n` +
                `**Feedback:** ${clean(get("message"))}`
            ));

            await sendLog(guild, `Feedback submitted by ${user.tag || user.username}.`, true);
            return reply("Thank you. Your feedback has been submitted.");
        }

        case "appresult": {
            if (!await requireStaff(ctx)) return;

            const target = get("user", "user");
            const result = get("result");
            const score = get("score", "integer");
            const notes = get("notes") || "No notes provided.";

            if (!target || !result) return reply("Usage: appresult @user Pass/Fail [score] [notes].");

            const destination = channelById(guild, cfg.applicationChannel) || ctx.channel;

            await destination.send(makeV2(
                `Application ${result}`,
                `**Applicant:** ${target}\n**Result:** ${result}\n` +
                `**Score:** ${score == null ? "Not provided" : `${score}/100`}\n` +
                `**Reviewed by:** ${user}\n**Notes:** ${notes}`
            ));

            await sendLog(guild,
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
                `Congratulations to ${target}!\n\n**New rank:** ${rank}\n` +
                `**Reason:** ${reason}\n**Announced by:** ${user}`
            ));

            await sendLog(guild,
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
                `**Member:** ${target}\n**Type:** ${type}\n` +
                `**Reason:** ${reason}\n**Issued by:** ${user}`
            ));

            await sendLog(guild,
                `${type} issued to ${target.tag} by ${user.tag}. Reason: ${reason}`,
                true
            );

            return reply("Infraction recorded.");
        }

        case "say": {
            if (!await requireStaff(ctx)) return;
            const message = clean(get("message"), 2000);
            if (message === "Not provided") return reply("Provide a message to send.");

            await ctx.channel.send({
                content: message,
                allowedMentions: { parse: [] }
            });

            return reply("Message sent.");
        }

        case "mediapost": {
            if (!interaction) return reply("Use the /mediapost slash command to attach files.");
            if (!await requireStaff(ctx)) return;

            const files = ["file", "file2", "file3", "file4"]
                .map(key => get(key, "attachment"))
                .filter(Boolean);

            if (!files.length) return reply("Please attach at least one file.");

            const caption = get("caption") || "";
            const creditedUser = get("photo_by", "user") || user;
            const time = new Date().toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit"
            });

            const preparedFiles = files.map((file, index) => ({
                source: file,
                uploadName: `media-${index + 1}-${String(file.name || "file").replace(/[^\w.-]/g, "_").slice(0, 80)}`
            }));

            const description =
                `📸 **Photo by:** ${creditedUser}` +
                (caption.trim() ? `\n\n${caption.trim()}` : "");

            const embeds = [];
            let firstImageEmbed = true;

            for (const file of preparedFiles) {
                const isImage = /^image\/(png|jpe?g|gif|webp|avif)$/i.test(
                    file.source.contentType || ""
                );

                if (!isImage) continue;

                const embed = new EmbedBuilder()
                    .setColor(0x283747)
                    .setImage(`attachment://${file.uploadName}`);

                if (firstImageEmbed) {
                    embed.setDescription(description);
                    embed.setFooter({ text: `Today at ${time}` });
                    firstImageEmbed = false;
                }

                embeds.push(embed);
            }

            if (!embeds.length) {
                embeds.push(
                    new EmbedBuilder()
                        .setColor(0x283747)
                        .setDescription(description)
                        .setFooter({ text: `Today at ${time}` })
                );
            }

            await ctx.channel.send({
                embeds,
                files: preparedFiles.map(file => ({
                    attachment: file.source.url,
                    name: file.uploadName
                })),
                allowedMentions: { users: [creditedUser.id] }
            });

            await sendLog(
                guild,
                `Media post published by ${user.tag} (${user.id}) in ${ctx.channel}.\n` +
                `Photo credit: ${creditedUser.tag || creditedUser.username} (${creditedUser.id})\n` +
                `Files: ${files.map(file => file.name).join(", ")}`,
                true
            );

            return reply("Media post published successfully.");
        }

        case "kick": {
            if (!await requireStaff(ctx)) return;
            const target = get("user", "user");
            const reason = get("reason") || `Kicked by ${user.tag}`;
            const member = target ? await guild.members.fetch(target.id).catch(() => null) : null;

            if (!member) return reply("Member not found.");
            if (!member.kickable) return reply("I cannot kick this member. Check role hierarchy.");

            await member.kick(reason);
            await sendLog(guild, `${target.tag} kicked by ${user.tag}. Reason: ${reason}`, true);
            return reply(`Kicked ${target.tag}.`);
        }

        case "ban": {
            if (!await requireStaff(ctx)) return;
            const target = get("user", "user");
            const reason = get("reason") || `Banned by ${user.tag}`;
            const member = target ? await guild.members.fetch(target.id).catch(() => null) : null;

            if (member && !member.bannable) return reply("I cannot ban this member. Check role hierarchy.");
            if (!target) return reply("Member not found.");

            await guild.members.ban(target.id, { reason });
            await sendLog(guild, `${target.tag} banned by ${user.tag}. Reason: ${reason}`, true);
            return reply(`Banned ${target.tag}.`);
        }

        case "unban": {
            if (!await requireStaff(ctx)) return;
            const id = String(get("userid") || "");

            if (!/^\d{17,20}$/.test(id)) return reply("Enter a valid Discord user ID.");

            await guild.members.unban(id, get("reason") || `Unbanned by ${user.tag}`);
            await sendLog(guild, `User ID ${id} unbanned by ${user.tag}.`, true);
            return reply(`Unbanned user ID ${id}.`);
        }

        case "timeout": {
            if (!await requireStaff(ctx)) return;
            const target = get("user", "user");
            const minutes = Number(get("minutes", "integer"));
            const member = target ? await guild.members.fetch(target.id).catch(() => null) : null;

            if (!member) return reply("Member not found.");
            if (!member.moderatable) return reply("I cannot timeout this member. Check role hierarchy.");

            await member.timeout(minutes * 60000, get("reason") || `Timed out by ${user.tag}`);
            await sendLog(guild, `${target.tag} timed out for ${minutes} minutes by ${user.tag}.`, true);
            return reply(`Timed out ${target.tag} for ${minutes} minutes.`);
        }

        case "untimeout": {
            if (!await requireStaff(ctx)) return;
            const target = get("user", "user");
            const member = target ? await guild.members.fetch(target.id).catch(() => null) : null;

            if (!member) return reply("Member not found.");
            if (!member.moderatable) return reply("I cannot modify this member.");

            await member.timeout(null, get("reason") || `Timeout removed by ${user.tag}`);
            await sendLog(guild, `Timeout removed from ${target.tag} by ${user.tag}.`, true);
            return reply(`Timeout removed from ${target.tag}.`);
        }

        case "purge": {
            if (!await requireStaff(ctx)) return;
            const amount = Number(get("amount", "integer"));

            if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
                return reply("Amount must be between 1 and 100.");
            }

            const deleted = await ctx.channel.bulkDelete(amount, true);
            await sendLog(guild,
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

            return reply(`Warned ${target.tag}. Warning count this session: ${list.length}.`);
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
                    content: `Message from California Operations staff:\n\n${message}`,
                    allowedMentions: { parse: [] }
                });

                await sendLog(guild, `Staff DM sent to ${target.tag} by ${user.tag}.`, true);
                return reply(`Message sent to ${target.tag}.`);
            } catch {
                return reply("Could not DM this user. Their DMs may be disabled.");
            }
        }
    }
}
/* READY AND MEMBER EVENTS */

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Prefix commands enabled: ${[...new Set([cfg.prefix, "!", "-"])].join(", ")}`);
    console.log(`${BRAND} is online.`);
    console.log("Windows speech mode: installed male voice preferred.");

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

/* MESSAGE AND SERVER LOGGING */

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
        sendLog(newRole.guild, `Role renamed from ${oldRole.name} to ${newRole.name}.`);
    }
});

client.on("guildBanAdd", ban => {
    sendLog(ban.guild, `${ban.user.tag} was banned.`);
});

client.on("guildBanRemove", ban => {
    sendLog(ban.guild, `${ban.user.tag} was unbanned.`);
});

/* PREFIX COMMANDS */

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

        if (name === "priority-panel" || name === "prioritypanel") {
            return await executeCommand(ctx, "priority-panel", args);
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

            if (
                !Number.isInteger(args.amount) ||
                args.amount < 1 ||
                args.amount > 100
            ) {
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

                if (
                    !Number.isInteger(args.minutes) ||
                    args.minutes < 1 ||
                    args.minutes > 40320
                ) {
                    return message.reply(
                        `Usage: ${prefix}timeout @user minutes reason`
                    );
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

/* INTERACTIONS */

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
                const type = interaction.values[0];
                const info = ticketTypes[type];

                if (!info) {
                    return replyPrivate(interaction, "Unknown ticket type.");
                }

                const modal = new ModalBuilder()
                    .setCustomId(`ticket:inquiry:${type}`)
                    .setTitle(`${info.label} Inquiry`);

                const inquiry = new TextInputBuilder()
                    .setCustomId("inquiry")
                    .setLabel("What do you need help with?")
                    .setPlaceholder("Describe your question, issue, or report...")
                    .setStyle(TextInputStyle.Paragraph)
                    .setMinLength(5)
                    .setMaxLength(1500)
                    .setRequired(true);

                modal.addComponents(row(inquiry));
                return interaction.showModal(modal);
            }

            if (interaction.customId === "priority:choose") {
                if (!isPriorityStaff(interaction.member)) {
                    return replyPrivate(
                        interaction,
                        "Only authorized staff can activate priority scenes."
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
                        : "Please find the ticket panel in this server."
                );
            }

            if (interaction.customId === "priority:request") {
                const modal = new ModalBuilder()
                    .setCustomId("priority:request:modal")
                    .setTitle("Request Priority");

                const scene = new TextInputBuilder()
                    .setCustomId("scene")
                    .setLabel("Scene type")
                    .setPlaceholder("Example: Bank Robbery, Hostage Scene")
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(100)
                    .setRequired(true);

                const location = new TextInputBuilder()
                    .setCustomId("location")
                    .setLabel("Scene location / postal")
                    .setPlaceholder("Enter the location or postal")
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(150)
                    .setRequired(true);

                const details = new TextInputBuilder()
                    .setCustomId("details")
                    .setLabel("Scene details")
                    .setPlaceholder("Explain what you are planning")
                    .setStyle(TextInputStyle.Paragraph)
                    .setMaxLength(800)
                    .setRequired(true);

                modal.addComponents(
                    row(scene),
                    row(location),
                    row(details)
                );

                return interaction.showModal(modal);
            }

            if (interaction.customId.startsWith("priority:approve:")) {
                const id = interaction.customId.split(":")[2];
                const request = priorityRequests.get(id);

                if (!request || request.guildId !== interaction.guildId) {
                    return replyPrivate(interaction, "Priority request not found.");
                }

                return await approvePriorityRequest(interaction, request);
            }

            if (interaction.customId.startsWith("priority:deny:")) {
                const id = interaction.customId.split(":")[2];
                const request = priorityRequests.get(id);

                if (!request || request.guildId !== interaction.guildId) {
                    return replyPrivate(interaction, "Priority request not found.");
                }

                return await denyPriorityRequest(interaction, request);
            }

            if (interaction.customId.startsWith("priority:start:")) {
                const id = interaction.customId.split(":")[2];
                const request = priorityRequests.get(id);

                if (!request || request.guildId !== interaction.guildId) {
                    return replyPrivate(interaction, "Priority request not found.");
                }

                return await startPriorityRequest(interaction, request);
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
                    return replyPrivate(interaction, "There is no active session vote.");
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
            interaction.customId === "priority:request:modal"
        ) {
            return await submitPriorityRequest(interaction);
        }

        if (
            interaction.isModalSubmit() &&
            interaction.customId.startsWith("ticket:inquiry:")
        ) {
            const type = interaction.customId.slice("ticket:inquiry:".length);
            const inquiry = clean(
                interaction.fields.getTextInputValue("inquiry"),
                1500
            );

            return await createTicket(interaction, type, inquiry);
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
            if (!isPriorityStaff(interaction.member)) {
                return replyPrivate(
                    interaction,
                    "Only authorized staff can activate priority scenes."
                );
            }

            if (priorities.has(interaction.guildId)) {
                return replyPrivate(interaction, "A priority scene is already active.");
            }

            const scene = interaction.customId.slice("priority:location:".length);
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
                const voice = await client.channels.fetch(cfg.voiceChannel).catch(() => null);

                if (voice && typeof voice.setStatus === "function") {
                    await voice.setStatus(`Priority: ${scene} - ${location}`)
                        .catch(error => {
                            console.error("Voice status update failed:", error.message);
                        });
                }
            }

            const announcementChannel =
                channelById(interaction.guild, cfg.priorityAnnouncementChannel) ||
                channelById(interaction.guild, cfg.priorityPanelChannel);

            if (announcementChannel) {
                await announcementChannel.send(makeV2(
                    "Priority Scene Started",
                    `A priority scene has been started at **${location}**.\n\n` +
                    `**Scene:** ${scene}\n**Started by:** ${interaction.user}\n` +
                    `**Duration:** ${cfg.priorityDurationMinutes} minutes`
                )).catch(console.error);
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

            const announcement =
                `Attention all units. ${scene} priority active at ${location}. Approach with caution.`;

            speakInVoiceChannel(announcement).catch(error => {
                console.error("[PRIORITY VOICE ANNOUNCEMENT FAILED]", error);
            });

            const timer = setTimeout(async () => {
                await endPriority(interaction.guild, client.user, true);
            }, cfg.priorityDurationMinutes * 60 * 1000);

            priorityTimers.set(interaction.guildId, timer);
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

/* STATUS WEBSITE */

const app = express();

app.disable("x-powered-by");
app.use(express.json());

app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>California Operations</title>
<style>
body{margin:0;background:#111;color:#eee;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(600px,85%);padding:28px;background:#191919;border:1px solid #333;border-radius:14px}
p{color:#bbb;line-height:1.6}
code{color:#fff}
</style>
</head>
<body>
<main>
<h1>California Operations</h1>
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
        priorityActive: priorities.size > 0,
        priorityRequests: priorityRequests.size,
        voiceChannelConfigured: Boolean(cfg.voiceChannel),
        voiceConnected
    });
});

app.listen(cfg.port, "0.0.0.0", () => {
    console.log(`Status website listening on port ${cfg.port}`);
});

/* ERROR HANDLING AND STARTUP */

process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
    console.error("Uncaught exception:", error);
});

(async () => {
    try {
        console.log("Starting California Operations...");
        await registerCommands();
        await client.login(cfg.token);
    } catch (error) {
        console.error("Failed to start California Operations:", error);
        process.exitCode = 1;
    }
})();