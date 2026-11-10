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
    Events,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
    AttachmentBuilder
} = require("discord.js");
const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType
} = require("@discordjs/voice");

const e = process.env;
const BRAND = "Texas Operations";
const PREFIX = e.PREFIX || "$";
const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;
const execFileAsync = promisify(execFile);

const cfg = {
    token: (e.DISCORD_TOKEN || e.BOT_TOKEN || "").trim().replace(/^Bot\s+/i, ""),
    clientId: (e.CLIENT_ID || "").trim(),
    guildId: (e.GUILD_ID || "").trim(),

    port: Number(e.PORT || 10000),
    prefix: PREFIX,

    ownerId: e.OWNER_ID || "",
    staffRoleId: e.STAFF_ROLE_ID || "",
    managementRoleId: e.MANAGEMENT_ROLE_ID || "",
    adminRoleId: e.ADMIN_ROLE_ID || "",
    priorityStaffRoleId: e.PRIORITY_STAFF_ROLE_ID || "",

    welcomeChannel: e.WELCOME_CHANNEL_ID || "",
    panelChannel: e.PANEL_CHANNEL_ID || "",
    ticketCategory: e.TICKET_CATEGORY_ID || "",
    ticketStaffRole: e.TICKET_STAFF_ROLE_ID || "",
    ticketLogChannel: e.TICKET_LOG_CHANNEL_ID || "",
    feedbackChannel: e.FEEDBACK_CHANNEL_ID || "",
    applicationChannel: e.APPLICATION_CHANNEL_ID || "",

    sessionChannel: e.SESSION_CHANNEL_ID || "",
    sessionLogChannel: e.SESSION_LOG_CHANNEL_ID || "",
    sessionBanner: e.SESSION_BANNER_URL || "",
    sessionRequiredVotes: Number(e.SESSION_REQUIRED_VOTES || 4),

    priorityPanelChannel: e.PRIORITY_PANEL_CHANNEL_ID || "",
    priorityAnnouncementChannel: e.PRIORITY_ANNOUNCEMENT_CHANNEL_ID || "",
    priorityLogChannel: e.PRIORITY_LOG_CHANNEL_ID || "",
    priorityDurationMinutes: Number(e.PRIORITY_DURATION_MINUTES || 30),
    priorityBanner: e.PRIORITY_BANNER_URL || "",

    generalLogChannel: e.GENERAL_LOG_CHANNEL_ID || "",
    memberLogChannel: e.MEMBER_LOG_CHANNEL_ID || "",
    moderationLogChannel: e.MODERATION_LOG_CHANNEL_ID || "",
    messageLogChannel: e.MESSAGE_LOG_CHANNEL_ID || "",
    roleLogChannel: e.ROLE_LOG_CHANNEL_ID || "",
    channelLogChannel: e.CHANNEL_LOG_CHANNEL_ID || "",
    voiceLogChannel: e.VOICE_LOG_CHANNEL_ID || "",
    serverLogChannel: e.SERVER_LOG_CHANNEL_ID || "",
    botLogChannel: e.BOT_LOG_CHANNEL_ID || "",

    voiceChannel: e.VOICE_CHANNEL_ID || "",
    voiceGuildId: e.VOICE_GUILD_ID || "",
    voiceEnabled: String(e.VOICE_ENABLED || "false").toLowerCase() === "true",
    voiceDisconnectRoleId: e.VOICE_DISCONNECT_ROLE_ID || "",

    automatedBanner: e.AUTOMATED_BANNER_URL || "",
    ticketBanner: e.TICKET_BANNER_URL || "",
    welcomeBanner: e.WELCOME_BANNER_URL || "",

    requiredVotes: Number(e.REQUIRED_VOTES || 4)
};

if (!cfg.token || !cfg.clientId) {
    console.error("ERROR: Add DISCORD_TOKEN (or BOT_TOKEN) and CLIENT_ID to your .env file.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
        Partials.User,
        Partials.GuildMember
    ]
});

const warnings = new Map();
const tickets = new Map();
const priorities = new Map();
const priorityRequests = new Map();
const priorityTimers = new Map();
const sessionVotes = new Map();
const activeSessions = new Map();
const ticketCounter = new Map();
const voicePlayers = new Map();
const voiceQueues = new Map();

const ticketTypes = {
    general: {
        label: "General Support",
        category: "general",
        description: "Questions and general support"
    },
    report: {
        label: "Report",
        category: "report",
        description: "Report a member or an incident"
    },
    management: {
        label: "Management",
        category: "management",
        description: "Contact server management"
    }
};

const priorityScenes = [
    { label: "Bank Robbery", value: "Bank Robbery" },
    { label: "Jewelry Store Robbery", value: "Jewelry Store Robbery" },
    { label: "Hostage Situation", value: "Hostage Situation" },
    { label: "Store Robbery", value: "Store Robbery" },
    { label: "Other Priority Scene", value: "Other Priority Scene" }
];

function clean(value, max = 1000) {
    if (value === null || value === undefined) return "Not provided";
    return String(value)
        .replace(/@everyone/gi, "@ everyone")
        .replace(/@here/gi, "@ here")
        .slice(0, max);
}

function isStaff(member) {
    if (!member) return false;

    if (cfg.ownerId && member.id === cfg.ownerId) return true;

    return Boolean(
        (cfg.staffRoleId && member.roles?.cache?.has(cfg.staffRoleId)) ||
        (cfg.managementRoleId && member.roles?.cache?.has(cfg.managementRoleId)) ||
        (cfg.adminRoleId && member.roles?.cache?.has(cfg.adminRoleId)) ||
        member.permissions?.has(PermissionFlagsBits.Administrator)
    );
}

function isManagement(member) {
    if (!member) return false;

    if (cfg.ownerId && member.id === cfg.ownerId) return true;

    return Boolean(
        (cfg.managementRoleId && member.roles?.cache?.has(cfg.managementRoleId)) ||
        (cfg.adminRoleId && member.roles?.cache?.has(cfg.adminRoleId)) ||
        member.permissions?.has(PermissionFlagsBits.Administrator)
    );
}

function isPriorityStaff(member) {
    if (!member) return false;

    if (cfg.ownerId && member.id === cfg.ownerId) return true;

    return Boolean(
        (cfg.priorityStaffRoleId && member.roles?.cache?.has(cfg.priorityStaffRoleId)) ||
        (cfg.managementRoleId && member.roles?.cache?.has(cfg.managementRoleId)) ||
        (cfg.adminRoleId && member.roles?.cache?.has(cfg.adminRoleId)) ||
        member.permissions?.has(PermissionFlagsBits.Administrator)
    );
}

function row(...components) {
    return new ActionRowBuilder().addComponents(...components);
}

function makeV2(title, description, options = {}) {
    const container = new ContainerBuilder();

    if (options.color) {
        container.setAccentColor(options.color);
    } else {
        container.setAccentColor(0x3498DB);
    }

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${title}\n${description || ""}`)
    );

    if (options.banner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(options.banner)
            )
        );
    }

    if (options.footer) {
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ${options.footer}`)
        );
    }

    return {
        components: [container],
        flags: V2
    };
}

async function replyPrivate(interaction, content) {
    const payload = typeof content === "string"
        ? { content, flags: EPHEMERAL }
        : { ...content, flags: (content.flags || 0) | EPHEMERAL };

    if (interaction.replied || interaction.deferred) {
        return interaction.followUp(payload);
    }

    return interaction.reply(payload);
}

function channelById(guild, id) {
    if (!guild || !id) return null;

    return guild.channels.cache.get(id) || null;
}

async function sendLog(guild, message, priority = false) {
    if (!guild) return;

    const channelId = priority && cfg.priorityLogChannel
        ? cfg.priorityLogChannel
        : cfg.generalLogChannel;

    if (!channelId) return;

    const channel = channelById(guild, channelId);
    if (!channel || !channel.isTextBased()) return;

    await channel.send({
        content: clean(message, 1900),
        allowedMentions: { parse: [] }
    }).catch(error => {
        console.error("Could not send log:", error.message);
    });
}

async function sendNamedLog(guild, channelId, message) {
    if (!guild || !channelId) return;

    const channel = channelById(guild, channelId);
    if (!channel || !channel.isTextBased()) return;

    await channel.send({
        content: clean(message, 1900),
        allowedMentions: { parse: [] }
    }).catch(error => {
        console.error("Could not send log:", error.message);
    });
}

function welcomeMessage(member) {
    const container = new ContainerBuilder()
        .setAccentColor(0x3498DB)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `# Welcome to ${BRAND}\n` +
                `Welcome ${member}!\n\n` +
                `Please read the server information and follow all community rules.`
            )
        );

    if (cfg.welcomeBanner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(cfg.welcomeBanner)
            )
        );
    }

    return {
        components: [container],
        flags: V2
    };
}

function ticketPanel() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId("ticket:create")
        .setPlaceholder("Select a ticket category")
        .addOptions(
            {
                label: "General Support",
                value: "general",
                description: "Questions and general support"
            },
            {
                label: "Report",
                value: "report",
                description: "Report a member or incident"
            },
            {
                label: "Management",
                value: "management",
                description: "Contact server management"
            }
        );

    const container = new ContainerBuilder()
        .setAccentColor(0x3498DB)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `# ${BRAND} Support\n` +
                "Select the appropriate category below to open a support ticket.\n\n" +
                "**General Support** — General questions and assistance.\n" +
                "**Report** — Report a member or incident.\n" +
                "**Management** — Contact the management team."
            )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(menu));

    if (cfg.ticketBanner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(cfg.ticketBanner)
            )
        );
    }

    return {
        components: [container],
        flags: V2
    };
}

function priorityPublicPanel() {
    const button = new ButtonBuilder()
        .setCustomId("priority:request")
        .setLabel("Request Priority")
        .setStyle(ButtonStyle.Primary);

    const container = new ContainerBuilder()
        .setAccentColor(0xE67E22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "# Priority Scene Request\n" +
                "Use the button below to request a priority scene.\n\n" +
                "Examples include bank robberies, jewelry store robberies, and hostage situations.\n\n" +
                "A member of the authorized staff team will review your request."
            )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(button));

    if (cfg.priorityBanner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(cfg.priorityBanner)
            )
        );
    }

    return {
        components: [container],
        flags: V2
    };
}

function priorityPanel() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId("priority:choose")
        .setPlaceholder("Select a priority scene")
        .addOptions(priorityScenes);

    const container = new ContainerBuilder()
        .setAccentColor(0xE67E22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "# Priority Management\n" +
                "Authorized staff can start a priority scene using the selector below.\n\n" +
                "Starting a priority will announce the scene and start its timer."
            )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(menu));

    if (cfg.priorityBanner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(cfg.priorityBanner)
            )
        );
    }

    return {
        components: [container],
        flags: V2
    };
}

function votePanel(state) {
    const yes = new ButtonBuilder()
        .setCustomId("session:yes")
        .setLabel("Yes")
        .setStyle(ButtonStyle.Success);

    const no = new ButtonBuilder()
        .setCustomId("session:no")
        .setLabel("No")
        .setStyle(ButtonStyle.Danger);

    const yesVotes = [...state.votes.values()].filter(vote => vote === "yes").length;
    const noVotes = [...state.votes.values()].filter(vote => vote === "no").length;

    const container = new ContainerBuilder()
        .setAccentColor(0x3498DB)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "# Session Vote\n" +
                "A session vote is currently active.\n\n" +
                `**Required yes votes:** ${state.required}\n` +
                `**Yes votes:** ${yesVotes}\n` +
                `**No votes:** ${noVotes}\n\n` +
                "Select a button below to cast or change your vote."
            )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(yes, no));

    if (cfg.sessionBanner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(cfg.sessionBanner)
            )
        );
    }

    return {
        components: [container],
        flags: V2
    };
}

async function refreshVote(guildId) {
    const state = sessionVotes.get(guildId);
    if (!state || !state.channelId || !state.messageId) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const channel = channelById(guild, state.channelId);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(state.messageId).catch(() => null);
    if (!message) return;

    await message.edit(votePanel(state)).catch(error => {
        console.error("Could not update session vote:", error.message);
    });

    const yesVotes = [...state.votes.values()].filter(vote => vote === "yes").length;

    if (!state.passed && yesVotes >= state.required) {
        state.passed = true;

        await channel.send(makeV2(
            "Session Vote Passed",
            `The session vote has passed with **${yesVotes} yes votes**.`
        ));

        await sendNamedLog(
            guild,
            cfg.sessionLogChannel,
            `Session vote passed in ${channel}. Yes votes: ${yesVotes}. Required: ${state.required}.`
        );
    }
}

async function startSession(guild, user) {
    const channel = channelById(guild, cfg.sessionChannel);
    if (!channel) {
        throw new Error("Session announcement channel is not configured.");
    }

    const container = new ContainerBuilder()
        .setAccentColor(0x2ECC71)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `# ${BRAND} Session Started\n` +
                "The roleplay session is now open.\n\n" +
                `**Host:** ${user}\n` +
                `**Started:** <t:${Math.floor(Date.now() / 1000)}:F>`
            )
        );

    if (cfg.sessionBanner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(cfg.sessionBanner)
            )
        );
    }

    const message = await channel.send({
        components: [container],
        flags: V2
    });

    activeSessions.set(guild.id, {
        hostId: user.id,
        startedAt: Date.now(),
        channelId: channel.id,
        messageId: message.id
    });

    await sendNamedLog(
        guild,
        cfg.sessionLogChannel,
        `Session started by ${user.tag || user.username}.`
    );
}

async function shutdownSession(guild, user) {
    const channel = channelById(guild, cfg.sessionChannel);
    if (!channel) {
        throw new Error("Session announcement channel is not configured.");
    }

    const session = activeSessions.get(guild.id);

    const container = new ContainerBuilder()
        .setAccentColor(0xE74C3C)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `# ${BRAND} Session Ended\n` +
                "The roleplay session has been shut down.\n\n" +
                `**Ended by:** ${user}\n` +
                `**Ended:** <t:${Math.floor(Date.now() / 1000)}:F>` +
                (session
                    ? `\n**Session duration:** ${Math.floor((Date.now() - session.startedAt) / 60000)} minutes`
                    : "")
            )
        );

    if (cfg.sessionBanner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(cfg.sessionBanner)
            )
        );
    }

    await channel.send({
        components: [container],
        flags: V2
    });

    activeSessions.delete(guild.id);

    await sendNamedLog(
        guild,
        cfg.sessionLogChannel,
        `Session shut down by ${user.tag || user.username}.`
    );
}

async function createTicket(interaction, type, inquiry) {
    const info = ticketTypes[type];
    if (!info) {
        return replyPrivate(interaction, "Invalid ticket category.");
    }

    const guild = interaction.guild;
    if (!guild) {
        return replyPrivate(interaction, "Tickets can only be opened in a server.");
    }

    const existing = guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildText &&
        channel.topic?.includes(`ticket-owner:${interaction.user.id}`)
    );

    if (existing) {
        return replyPrivate(
            interaction,
            `You already have an open ticket: ${existing}`
        );
    }

    const counter = (ticketCounter.get(guild.id) || 0) + 1;
    ticketCounter.set(guild.id, counter);

    const safeName = interaction.user.username
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 18) || "member";

    const channel = await guild.channels.create({
        name: `${type}-${safeName}-${counter}`,
        type: ChannelType.GuildText,
        parent: cfg.ticketCategory || null,
        topic: `ticket-owner:${interaction.user.id}; ticket-type:${type}`,
        permissionOverwrites: [
            {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel]
            },
            {
                id: interaction.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles
                ]
            },
            ...(cfg.ticketStaffRole
                ? [{
                    id: cfg.ticketStaffRole,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageMessages
                    ]
                }]
                : [])
        ]
    });

    tickets.set(channel.id, {
        ownerId: interaction.user.id,
        type,
        createdAt: Date.now(),
        claimedBy: null
    });

    const claim = new ButtonBuilder()
        .setCustomId("ticket:claim")
        .setLabel("Claim Ticket")
        .setStyle(ButtonStyle.Primary);

    const close = new ButtonBuilder()
        .setCustomId("ticket:close")
        .setLabel("Close Ticket")
        .setStyle(ButtonStyle.Danger);

    const container = new ContainerBuilder()
        .setAccentColor(0x3498DB)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `# ${info.label}\n` +
                `Hello ${interaction.user}, your ticket has been created.\n\n` +
                `**Category:** ${info.label}\n` +
                `**Inquiry:** ${inquiry}\n\n` +
                "A staff member will assist you as soon as possible."
            )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(claim, close));

    if (cfg.ticketBanner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(cfg.ticketBanner)
            )
        );
    }

    await channel.send({
        content: cfg.ticketStaffRole ? `<@&${cfg.ticketStaffRole}>` : "",
        components: [container],
        flags: V2,
        allowedMentions: {
            roles: cfg.ticketStaffRole ? [cfg.ticketStaffRole] : []
        }
    });

    await sendNamedLog(
        guild,
        cfg.ticketLogChannel,
        `Ticket created: ${channel} by ${interaction.user.tag}. Category: ${info.label}.`
    );

    return replyPrivate(
        interaction,
        `Your ticket has been created: ${channel}`
    );
}

async function claimTicket(interaction) {
    const channel = interaction.channel;
    const ticket = tickets.get(channel.id);

    if (!ticket) {
        return replyPrivate(interaction, "This channel is not an active ticket.");
    }

    if (!isStaff(interaction.member)) {
        return replyPrivate(interaction, "Only staff members can claim tickets.");
    }

    if (ticket.claimedBy) {
        return replyPrivate(
            interaction,
            `This ticket has already been claimed by <@${ticket.claimedBy}>.`
        );
    }

    ticket.claimedBy = interaction.user.id;

    await channel.send({
        content: `This ticket has been claimed by ${interaction.user}.`,
        allowedMentions: { users: [interaction.user.id] }
    });

    await sendNamedLog(
        interaction.guild,
        cfg.ticketLogChannel,
        `Ticket ${channel.name} claimed by ${interaction.user.tag}.`
    );

    return replyPrivate(interaction, "You have claimed this ticket.");
}

async function closeTicket(interaction) {
    const channel = interaction.channel;
    const ticket = tickets.get(channel.id);

    if (!ticket) {
        return replyPrivate(interaction, "This channel is not an active ticket.");
    }

    if (
        interaction.user.id !== ticket.ownerId &&
        !isStaff(interaction.member)
    ) {
        return replyPrivate(interaction, "Only the ticket owner or staff can close this ticket.");
    }

    const modal = new ModalBuilder()
        .setCustomId("ticket:close:reason")
        .setTitle("Close Ticket");

    const reason = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason for closing")
        .setPlaceholder("Enter a short closing reason")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(300)
        .setRequired(true);

    modal.addComponents(row(reason));
    return interaction.showModal(modal);
}

async function submitTicketClosure(interaction) {
    const channel = interaction.channel;
    const ticket = tickets.get(channel.id);

    if (!ticket) {
        return replyPrivate(interaction, "This ticket is no longer active.");
    }

    if (
        interaction.user.id !== ticket.ownerId &&
        !isStaff(interaction.member)
    ) {
        return replyPrivate(interaction, "Only the ticket owner or staff can close this ticket.");
    }

    const reason = clean(
        interaction.fields.getTextInputValue("reason"),
        300
    );

    await replyPrivate(interaction, "Ticket is being closed.");

    await sendNamedLog(
        interaction.guild,
        cfg.ticketLogChannel,
        `Ticket closed: ${channel.name}. Owner: ${ticket.ownerId}. Closed by: ${interaction.user.tag}. Reason: ${reason}`
    );

    tickets.delete(channel.id);

    await channel.delete(`Ticket closed by ${interaction.user.tag}: ${reason}`)
        .catch(error => console.error("Ticket deletion failed:", error));
}

async function submitPriorityRequest(interaction) {
    const scene = clean(
        interaction.fields.getTextInputValue("scene"),
        100
    );

    const location = clean(
        interaction.fields.getTextInputValue("location"),
        150
    );

    const details = clean(
        interaction.fields.getTextInputValue("details"),
        800
    );

    const id = `${Date.now()}-${interaction.user.id}`;

    const request = {
        id,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        scene,
        location,
        details,
        createdAt: Date.now(),
        status: "pending"
    };

    priorityRequests.set(id, request);

    const approve = new ButtonBuilder()
        .setCustomId(`priority:approve:${id}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success);

    const deny = new ButtonBuilder()
        .setCustomId(`priority:deny:${id}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger);

    const container = new ContainerBuilder()
        .setAccentColor(0xE67E22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "# New Priority Request\n" +
                `**Requested by:** <@${interaction.user.id}>\n` +
                `**Scene:** ${scene}\n` +
                `**Location:** ${location}\n` +
                `**Details:** ${details}\n` +
                `**Status:** Pending review`
            )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(approve, deny));

    const destination =
        channelById(interaction.guild, cfg.priorityAnnouncementChannel) ||
        channelById(interaction.guild, cfg.priorityPanelChannel);

    if (!destination) {
        priorityRequests.delete(id);
        return replyPrivate(
            interaction,
            "The priority request channel is not configured. Contact an administrator."
        );
    }

    const sent = await destination.send({
        components: [container],
        flags: V2
    });

    request.messageId = sent.id;
    request.channelId = destination.id;

    await sendLog(
        interaction.guild,
        `Priority request submitted by ${interaction.user.tag}: ${scene} at ${location}.`,
        true
    );

    return replyPrivate(
        interaction,
        "Your priority request has been submitted for staff review."
    );
}

async function approvePriorityRequest(interaction, request) {
    if (!isPriorityStaff(interaction.member)) {
        return replyPrivate(interaction, "You are not authorized to approve priority requests.");
    }

    if (request.status !== "pending") {
        return replyPrivate(interaction, "This request has already been reviewed.");
    }

    request.status = "approved";
    request.approvedBy = interaction.user.id;

    const container = new ContainerBuilder()
        .setAccentColor(0x2ECC71)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "# Priority Request Approved\n" +
                `**Scene:** ${request.scene}\n` +
                `**Location:** ${request.location}\n` +
                `**Requested by:** <@${request.userId}>\n` +
                `**Approved by:** ${interaction.user}\n\n` +
                "Staff may now start this priority scene."
            )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(
            new ButtonBuilder()
                .setCustomId(`priority:start:${request.id}`)
                .setLabel("Start Priority")
                .setStyle(ButtonStyle.Success)
        ));

    await interaction.message.edit({
        components: [container],
        flags: V2
    });

    await sendLog(
        interaction.guild,
        `Priority request ${request.id} approved by ${interaction.user.tag}.`,
        true
    );

    return replyPrivate(interaction, "Priority request approved.");
}

async function denyPriorityRequest(interaction, request) {
    if (!isPriorityStaff(interaction.member)) {
        return replyPrivate(interaction, "You are not authorized to deny priority requests.");
    }

    if (request.status !== "pending") {
        return replyPrivate(interaction, "This request has already been reviewed.");
    }

    request.status = "denied";
    request.deniedBy = interaction.user.id;

    const container = new ContainerBuilder()
        .setAccentColor(0xE74C3C)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "# Priority Request Denied\n" +
                `**Scene:** ${request.scene}\n` +
                `**Location:** ${request.location}\n` +
                `**Requested by:** <@${request.userId}>\n` +
                `**Denied by:** ${interaction.user}`
            )
        );

    await interaction.message.edit({
        components: [container],
        flags: V2
    });

    await sendLog(
        interaction.guild,
        `Priority request ${request.id} denied by ${interaction.user.tag}.`,
        true
    );

    return replyPrivate(interaction, "Priority request denied.");
}

async function startPriorityRequest(interaction, request) {
    if (!isPriorityStaff(interaction.member)) {
        return replyPrivate(interaction, "You are not authorized to start priority scenes.");
    }

    if (request.status !== "approved") {
        return replyPrivate(interaction, "This request has not been approved.");
    }

    if (priorities.has(interaction.guildId)) {
        return replyPrivate(interaction, "A priority scene is already active.");
    }

    request.status = "started";

    priorities.set(interaction.guildId, {
        scene: request.scene,
        location: request.location,
        userId: interaction.user.id,
        startedAt: Date.now(),
        requestId: request.id
    });

    await announcePriorityStart(interaction.guild, request, interaction.user);

    const timer = setTimeout(async () => {
        await endPriority(interaction.guild, client.user, true);
    }, cfg.priorityDurationMinutes * 60 * 1000);

    priorityTimers.set(interaction.guildId, timer);

    const container = new ContainerBuilder()
        .setAccentColor(0x2ECC71)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "# Priority Started\n" +
                `**Scene:** ${request.scene}\n` +
                `**Location:** ${request.location}\n` +
                `**Started by:** ${interaction.user}\n` +
                `**Duration:** ${cfg.priorityDurationMinutes} minutes`
            )
        );

    await interaction.message.edit({
        components: [container],
        flags: V2
    });

    await sendLog(
        interaction.guild,
        `Priority started from request ${request.id} by ${interaction.user.tag}.`,
        true
    );

    return replyPrivate(interaction, "Priority scene started.");
}

async function announcePriorityStart(guild, request, user) {
    const channel = channelById(guild, cfg.priorityAnnouncementChannel);
    if (!channel) return;

    await channel.send(makeV2(
        "Priority Scene Started",
        `A priority scene has been started at **${request.location}**.\n\n` +
        `**Scene:** ${request.scene}\n` +
        `**Started by:** ${user}\n` +
        `**Duration:** ${cfg.priorityDurationMinutes} minutes`,
        { color: 0xE67E22, banner: cfg.priorityBanner }
    ));

    await sendLog(
        guild,
        `Priority scene started: ${request.scene} at ${request.location}.`,
        true
    );
}

async function endPriority(guild, user, automatic = false) {
    if (!guild) return;

    const previous = priorities.get(guild.id);
    if (!previous) return;

    priorities.delete(guild.id);

    const timer = priorityTimers.get(guild.id);
    if (timer) clearTimeout(timer);
    priorityTimers.delete(guild.id);

    const channel = channelById(guild, cfg.priorityAnnouncementChannel);

    if (channel) {
        await channel.send(makeV2(
            "Priority Scene Ended",
            `The active priority scene has ended.\n\n` +
            `**Scene:** ${previous.scene}\n` +
            `**Location:** ${previous.location}\n` +
            `**Ended by:** ${user}\n` +
            `**Duration:** ${Math.floor((Date.now() - previous.startedAt) / 60000)} minutes\n` +
            `**End type:** ${automatic ? "Automatic timer" : "Manual"}`
        )).catch(console.error);
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
                "Texas Operations Commands",
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
                "Texas Operations Feedback",
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
                    content: `Message from Texas Operations staff:\n\n${message}`,
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
        console.log("----------------------------------------");
        console.log("Starting Texas Operations...");
        console.log("----------------------------------------");

        console.log("[DISCORD] Authenticating bot...");
        await client.login(cfg.token);
        console.log("[DISCORD] Authentication successful.");
        console.log(`[DISCORD] Logged in as ${client.user.tag}`);

        console.log("[COMMANDS] Registering slash commands...");
        await registerCommands();
        console.log("[COMMANDS] Slash commands registered successfully.");

        console.log("----------------------------------------");
        console.log("Texas Operations started successfully.");
        console.log("----------------------------------------");
    } catch (error) {
        console.error("----------------------------------------");
        console.error("TEXAS OPERATIONS STARTUP FAILED");
        console.error("----------------------------------------");

        if (error?.status === 401 || error?.code === 0) {
            console.error("[AUTHENTICATION] Discord rejected the bot token.");
            console.error("Check DISCORD_TOKEN or BOT_TOKEN in your hosting environment.");
            console.error("Use the Bot Token from Discord Developer Portal, not the Client Secret.");
        } else {
            console.error("[STARTUP ERROR]", error);
        }
        process.exit(1);
    }
})();
