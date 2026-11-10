export class ProjectBackupError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ProjectBackupError'; this.status = status; }
}
