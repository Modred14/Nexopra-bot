// ─────────────────────────────────────────────────────────────────────────────
// core/users.js — Persistent User Store
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";

const USERS_FILE = "users.json";
let users = {};

export function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  }
  return users;
}

export function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

export function getUser(jid) {
  return users[jid] || null;
}

export function setUser(jid, data) {
  users[jid] = { ...users[jid], ...data };
  saveUsers();
}

export function getAllUsers() {
  return users;
}

export function userExists(jid) {
  return !!users[jid];
}
