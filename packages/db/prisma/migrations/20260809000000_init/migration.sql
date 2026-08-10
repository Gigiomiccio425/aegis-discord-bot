-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CaseType" AS ENUM ('NOTE', 'WARN', 'MUTE', 'KICK', 'BAN', 'UNBAN', 'QUARANTINE', 'UNQUARANTINE', 'PURGE', 'ROLE_STRIP');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'APPEALED', 'UPHELD');

-- CreateEnum
CREATE TYPE "IncidentKind" AS ENUM ('RAID', 'NUKE', 'MASS_SPAM', 'COMPROMISE_WAVE', 'MANUAL_LOCKDOWN');

-- CreateEnum
CREATE TYPE "SnapshotKind" AS ENUM ('SCHEDULED', 'MANUAL', 'EMERGENCY', 'PRE_RESTORE');

-- CreateEnum
CREATE TYPE "ThreatKind" AS ENUM ('DOMAIN', 'URL', 'IMAGE_PHASH', 'FILE_SHA256', 'REGEX', 'KEYWORD');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PanelRole" AS ENUM ('OWNER', 'ADMIN', 'MOD', 'VIEWER');

-- CreateTable
CREATE TABLE "Guild" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconHash" TEXT,
    "ownerId" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigHistory" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "paths" TEXT[],
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorTag" TEXT,
    "targetId" TEXT,
    "targetTag" TEXT,
    "channelId" TEXT,
    "messageId" TEXT,
    "roleId" TEXT,
    "summary" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "severity" INTEGER NOT NULL DEFAULT 0,
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "caseId" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageArchive" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorTag" TEXT,
    "content" TEXT,
    "fingerprint" TEXT,
    "embeds" JSONB NOT NULL DEFAULT '[]',
    "stickers" JSONB NOT NULL DEFAULT '[]',
    "replyToId" TEXT,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "MessageArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentArchive" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT,
    "sha256" TEXT,
    "phash" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "verdict" TEXT NOT NULL DEFAULT 'UNSCANNED',
    "scanResult" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttachmentArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "CaseType" NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "targetId" TEXT NOT NULL,
    "targetTag" TEXT,
    "actorId" TEXT NOT NULL,
    "actorTag" TEXT,
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "module" TEXT,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "appealText" TEXT,
    "appealAt" TIMESTAMP(3),
    "appealResolvedAt" TIMESTAMP(3),
    "appealResolvedBy" TEXT,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT,
    "avatarHash" TEXT,
    "avatarPhash" TEXT,
    "accountCreatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "joinCount" INTEGER NOT NULL DEFAULT 1,
    "inviteCode" TEXT,
    "invitedBy" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskUpdatedAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "dormantSince" TIMESTAMP(3),
    "warnCount" INTEGER NOT NULL DEFAULT 0,
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "quarantinedAt" TIMESTAMP(3),
    "quarantineReason" TEXT,
    "rolesBeforeQuarantine" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRolesAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "notes" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceSession" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "leftAt" TIMESTAMP(3),
    "seconds" INTEGER,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "video" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VoiceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" "IncidentKind" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "actorId" TEXT,
    "affectedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actionsTaken" JSONB NOT NULL DEFAULT '[]',
    "peakRate" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "resolvedBy" TEXT,
    "notes" TEXT,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" "SnapshotKind" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "roles" JSONB NOT NULL DEFAULT '[]',
    "channels" JSONB NOT NULL DEFAULT '[]',
    "emojis" JSONB NOT NULL DEFAULT '[]',
    "stickers" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "automod" JSONB NOT NULL DEFAULT '[]',
    "memberRoles" JSONB NOT NULL DEFAULT '[]',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "restoredAt" TIMESTAMP(3),
    "restoredBy" TEXT,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreatSignature" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "kind" "ThreatKind" NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "campaign" TEXT,
    "severity" INTEGER NOT NULL DEFAULT 50,
    "description" TEXT,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "expiresAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ThreatSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookRecord" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "creatorId" TEXT,
    "managed" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WebhookRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotRecord" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addedBy" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "permissions" TEXT NOT NULL DEFAULT '0',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "lastAuditAt" TIMESTAMP(3),

    CONSTRAINT "BotRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteRecord" (
    "code" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT,
    "inviterId" TEXT,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER NOT NULL DEFAULT 0,
    "temporary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "watched" BOOLEAN NOT NULL DEFAULT false,
    "atRisk" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "InviteRecord_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Persona" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "color" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomCommand" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deniedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "args" JSONB NOT NULL DEFAULT '[]',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "cooldownSec" INTEGER NOT NULL DEFAULT 3,
    "guildCooldownSec" INTEGER NOT NULL DEFAULT 0,
    "ephemeralAck" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwitchSubscription" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "twitchUserId" TEXT NOT NULL,
    "twitchLogin" TEXT NOT NULL,
    "eventsubId" TEXT,
    "eventsubType" TEXT NOT NULL DEFAULT 'stream.online',
    "announceChannelId" TEXT,
    "liveRoleId" TEXT,
    "lastLiveAt" TIMESTAMP(3),
    "lastAnnouncedAt" TIMESTAMP(3),
    "lastClipCheckAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwitchSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialSource" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "displayName" TEXT,
    "lastItemId" TEXT,
    "lastItemAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Poll" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "multiSelect" BOOLEAN NOT NULL DEFAULT false,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "allowedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closesAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Poll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "voterKey" TEXT NOT NULL,
    "optionIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "votedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Giveaway" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "prize" TEXT NOT NULL,
    "winnerCount" INTEGER NOT NULL DEFAULT 1,
    "requirements" JSONB NOT NULL DEFAULT '{}',
    "hostId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "winnerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiveawayEntry" (
    "id" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rejected" TEXT,

    CONSTRAINT "GiveawayEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "channelId" TEXT,
    "openerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closeReason" TEXT,
    "transcriptPath" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StarboardEntry" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "sourceChannelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "starboardMessageId" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StarboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReactionRoleSet" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "title" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "mode" TEXT NOT NULL DEFAULT 'MULTI',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReactionRoleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PanelAccess" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "PanelRole" NOT NULL DEFAULT 'VIEWER',
    "grantedBy" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "PanelAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PanelSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userTag" TEXT,
    "avatar" TEXT,
    "tokenEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PanelSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErasureRequest" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "summary" JSONB NOT NULL DEFAULT '{}',
    "requestedBy" TEXT,

    CONSTRAINT "ErasureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Guild_active_idx" ON "Guild"("active");

-- CreateIndex
CREATE INDEX "ConfigHistory_guildId_createdAt_idx" ON "ConfigHistory"("guildId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_guildId_createdAt_idx" ON "AuditEvent"("guildId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_guildId_type_createdAt_idx" ON "AuditEvent"("guildId", "type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_guildId_actorId_createdAt_idx" ON "AuditEvent"("guildId", "actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_guildId_targetId_createdAt_idx" ON "AuditEvent"("guildId", "targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_guildId_category_createdAt_idx" ON "AuditEvent"("guildId", "category", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_guildId_severity_idx" ON "AuditEvent"("guildId", "severity");

-- CreateIndex
CREATE INDEX "MessageArchive_guildId_createdAt_idx" ON "MessageArchive"("guildId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MessageArchive_guildId_authorId_createdAt_idx" ON "MessageArchive"("guildId", "authorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MessageArchive_guildId_channelId_createdAt_idx" ON "MessageArchive"("guildId", "channelId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MessageArchive_guildId_fingerprint_idx" ON "MessageArchive"("guildId", "fingerprint");

-- CreateIndex
CREATE INDEX "MessageArchive_deletedAt_idx" ON "MessageArchive"("deletedAt");

-- CreateIndex
CREATE INDEX "AttachmentArchive_guildId_createdAt_idx" ON "AttachmentArchive"("guildId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AttachmentArchive_phash_idx" ON "AttachmentArchive"("phash");

-- CreateIndex
CREATE INDEX "AttachmentArchive_sha256_idx" ON "AttachmentArchive"("sha256");

-- CreateIndex
CREATE INDEX "AttachmentArchive_verdict_idx" ON "AttachmentArchive"("verdict");

-- CreateIndex
CREATE INDEX "Case_guildId_targetId_createdAt_idx" ON "Case"("guildId", "targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Case_guildId_status_idx" ON "Case"("guildId", "status");

-- CreateIndex
CREATE INDEX "Case_guildId_expiresAt_idx" ON "Case"("guildId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Case_guildId_number_key" ON "Case"("guildId", "number");

-- CreateIndex
CREATE INDEX "UserProfile_guildId_riskScore_idx" ON "UserProfile"("guildId", "riskScore" DESC);

-- CreateIndex
CREATE INDEX "UserProfile_guildId_lastSeenAt_idx" ON "UserProfile"("guildId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "UserProfile_guildId_quarantinedAt_idx" ON "UserProfile"("guildId", "quarantinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_guildId_userId_key" ON "UserProfile"("guildId", "userId");

-- CreateIndex
CREATE INDEX "VoiceSession_guildId_userId_joinedAt_idx" ON "VoiceSession"("guildId", "userId", "joinedAt" DESC);

-- CreateIndex
CREATE INDEX "VoiceSession_guildId_channelId_joinedAt_idx" ON "VoiceSession"("guildId", "channelId", "joinedAt" DESC);

-- CreateIndex
CREATE INDEX "Incident_guildId_startedAt_idx" ON "Incident"("guildId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Incident_guildId_kind_idx" ON "Incident"("guildId", "kind");

-- CreateIndex
CREATE INDEX "Snapshot_guildId_createdAt_idx" ON "Snapshot"("guildId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ThreatSignature_kind_enabled_idx" ON "ThreatSignature"("kind", "enabled");

-- CreateIndex
CREATE INDEX "ThreatSignature_guildId_kind_idx" ON "ThreatSignature"("guildId", "kind");

-- CreateIndex
CREATE INDEX "ThreatSignature_campaign_idx" ON "ThreatSignature"("campaign");

-- CreateIndex
CREATE UNIQUE INDEX "ThreatSignature_kind_value_guildId_key" ON "ThreatSignature"("kind", "value", "guildId");

-- CreateIndex
CREATE INDEX "WebhookRecord_guildId_approved_idx" ON "WebhookRecord"("guildId", "approved");

-- CreateIndex
CREATE INDEX "BotRecord_guildId_riskScore_idx" ON "BotRecord"("guildId", "riskScore" DESC);

-- CreateIndex
CREATE INDEX "InviteRecord_guildId_deletedAt_idx" ON "InviteRecord"("guildId", "deletedAt");

-- CreateIndex
CREATE INDEX "InviteRecord_watched_atRisk_idx" ON "InviteRecord"("watched", "atRisk");

-- CreateIndex
CREATE UNIQUE INDEX "Persona_guildId_name_key" ON "Persona"("guildId", "name");

-- CreateIndex
CREATE INDEX "CustomCommand_guildId_enabled_idx" ON "CustomCommand"("guildId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "CustomCommand_guildId_name_key" ON "CustomCommand"("guildId", "name");

-- CreateIndex
CREATE INDEX "TwitchSubscription_twitchUserId_idx" ON "TwitchSubscription"("twitchUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TwitchSubscription_guildId_twitchUserId_eventsubType_key" ON "TwitchSubscription"("guildId", "twitchUserId", "eventsubType");

-- CreateIndex
CREATE INDEX "SocialSource_platform_lastCheckedAt_idx" ON "SocialSource"("platform", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialSource_guildId_platform_identifier_key" ON "SocialSource"("guildId", "platform", "identifier");

-- CreateIndex
CREATE INDEX "Poll_guildId_closesAt_idx" ON "Poll"("guildId", "closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "PollVote_pollId_voterKey_key" ON "PollVote"("pollId", "voterKey");

-- CreateIndex
CREATE INDEX "Giveaway_guildId_endsAt_idx" ON "Giveaway"("guildId", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "GiveawayEntry_giveawayId_userId_key" ON "GiveawayEntry"("giveawayId", "userId");

-- CreateIndex
CREATE INDEX "Ticket_guildId_status_idx" ON "Ticket"("guildId", "status");

-- CreateIndex
CREATE INDEX "Ticket_guildId_openerId_idx" ON "Ticket"("guildId", "openerId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_guildId_number_key" ON "Ticket"("guildId", "number");

-- CreateIndex
CREATE INDEX "StarboardEntry_guildId_count_idx" ON "StarboardEntry"("guildId", "count" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "StarboardEntry_guildId_sourceMessageId_key" ON "StarboardEntry"("guildId", "sourceMessageId");

-- CreateIndex
CREATE INDEX "ReactionRoleSet_guildId_idx" ON "ReactionRoleSet"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "PanelAccess_guildId_userId_key" ON "PanelAccess"("guildId", "userId");

-- CreateIndex
CREATE INDEX "PanelSession_userId_idx" ON "PanelSession"("userId");

-- CreateIndex
CREATE INDEX "PanelSession_expiresAt_idx" ON "PanelSession"("expiresAt");

-- CreateIndex
CREATE INDEX "ErasureRequest_userId_idx" ON "ErasureRequest"("userId");

-- AddForeignKey
ALTER TABLE "ConfigHistory" ADD CONSTRAINT "ConfigHistory_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageArchive" ADD CONSTRAINT "MessageArchive_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentArchive" ADD CONSTRAINT "AttachmentArchive_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MessageArchive"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceSession" ADD CONSTRAINT "VoiceSession_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreatSignature" ADD CONSTRAINT "ThreatSignature_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookRecord" ADD CONSTRAINT "WebhookRecord_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRecord" ADD CONSTRAINT "BotRecord_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteRecord" ADD CONSTRAINT "InviteRecord_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomCommand" ADD CONSTRAINT "CustomCommand_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwitchSubscription" ADD CONSTRAINT "TwitchSubscription_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialSource" ADD CONSTRAINT "SocialSource_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Poll" ADD CONSTRAINT "Poll_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "Poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Giveaway" ADD CONSTRAINT "Giveaway_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayEntry" ADD CONSTRAINT "GiveawayEntry_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StarboardEntry" ADD CONSTRAINT "StarboardEntry_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReactionRoleSet" ADD CONSTRAINT "ReactionRoleSet_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelAccess" ADD CONSTRAINT "PanelAccess_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

