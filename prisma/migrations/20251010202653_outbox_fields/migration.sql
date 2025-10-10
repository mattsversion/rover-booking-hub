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
    CONSTRAINT "Message_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("body", "bookingId", "channel", "createdAt", "direction", "fromLabel", "id", "toLabel") SELECT "body", "bookingId", "channel", "createdAt", "direction", "fromLabel", "id", "toLabel" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
