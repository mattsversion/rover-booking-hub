-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "fromLabel" TEXT,
    "toLabel" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "toPhone" TEXT,
    "isQueued" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" DATETIME,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "eid" TEXT,
    "platform" TEXT,
    "threadId" TEXT,
    "providerMessageId" TEXT,
    "fromPhone" TEXT,
    "isBookingCandidate" BOOLEAN NOT NULL DEFAULT false,
    "extractedKeywordsJson" TEXT,
    "extractedDatesJson" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("body", "bookingId", "channel", "createdAt", "direction", "failCount", "fromLabel", "id", "isQueued", "sentAt", "toLabel", "toPhone") SELECT "body", "bookingId", "channel", "createdAt", "direction", "failCount", "fromLabel", "id", "isQueued", "sentAt", "toLabel", "toPhone" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE UNIQUE INDEX "Message_eid_key" ON "Message"("eid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
