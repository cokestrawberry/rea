import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { err, ok, type Result } from "../domain/result.js";
import {
  readRegularFile,
  RegularFileCleanupFailure,
} from "./RegularFileRead.js";

export interface RecoveryBackupSelection {
  readonly backupPath: string;
  readonly present: boolean;
}

export interface RecoveryBackupSelectionFailure {
  readonly kind: "unreadable" | "occupied";
  readonly path: string;
  readonly detail: string;
}

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Select a persistent snapshot only when its bytes match this transaction's original. */
export const selectCurrentRecoveryBackup = async (
  firstBackupPath: string,
  original: string | Buffer,
): Promise<Result<RecoveryBackupSelection, RecoveryBackupSelectionFailure>> => {
  const expected = Buffer.isBuffer(original)
    ? original
    : Buffer.from(original, "utf8");
  let firstBackup: Buffer | undefined;
  try {
    firstBackup = await readRegularFile(firstBackupPath, {
      symlinks: "reject",
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isMissing(cause))
      return err({
        kind: "unreadable",
        path: firstBackupPath,
        detail: `The recovery backup could not be checked: ${errorDetail(cause)}`,
      });
  }
  if (firstBackup === undefined)
    return ok({ backupPath: firstBackupPath, present: false });
  if (firstBackup.equals(expected))
    return ok({ backupPath: firstBackupPath, present: true });

  const digest = createHash("sha256").update(expected).digest("hex");
  const recoveryPath = `${firstBackupPath}.${digest}.recovery`;
  let recovery: Buffer | undefined;
  try {
    recovery = await readRegularFile(recoveryPath, { symlinks: "reject" });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isMissing(cause))
      return err({
        kind: "unreadable",
        path: recoveryPath,
        detail: `The recovery backup could not be checked: ${errorDetail(cause)}`,
      });
  }
  if (recovery !== undefined && !recovery.equals(expected))
    return err({
      kind: "occupied",
      path: recoveryPath,
      detail: `The recovery path already contains different data: ${recoveryPath}`,
    });
  return ok({ backupPath: recoveryPath, present: recovery !== undefined });
};

/** Preserve a snapshot without replacing an earlier recovery file. */
export const preserveRecoveryBackup = async (
  source: string,
  destination: string,
): Promise<boolean> => {
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (cause: unknown) {
    return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
  }
};

/** Preserve `source` and return the path that verifiably holds its original bytes. */
export const preserveCurrentRecoveryBackup = async (
  source: string,
  firstBackupPath: string,
  original: string | Buffer,
): Promise<string | undefined> => {
  const selection = await selectCurrentRecoveryBackup(
    firstBackupPath,
    original,
  );
  if (
    !selection.ok ||
    !(await preserveRecoveryBackup(source, selection.value.backupPath))
  )
    return undefined;
  const verified = await selectCurrentRecoveryBackup(firstBackupPath, original);
  return verified.ok &&
    verified.value.present &&
    verified.value.backupPath === selection.value.backupPath
    ? verified.value.backupPath
    : undefined;
};
