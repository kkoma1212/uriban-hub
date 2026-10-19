import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectSmtpSocket } from "./smtp-socket.js";

vi.mock("node:net", () => ({ createConnection: vi.fn() }));

describe("SMTP OS resolver connection", () => {
  let socket: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.useFakeTimers();
    socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    vi.mocked(createConnection).mockReturnValue(socket as unknown as Socket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("bounds stalled DNS resolution and destroys the unused socket", () => {
    const callback = vi.fn();
    connectSmtpSocket({ host: "smtp.example.com", port: 587 }, callback);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: "ETIMEDOUT" }), false);
    socket.emit("error", Object.assign(new Error("late DNS failure"), { code: "ENOTFOUND" }));
    socket.emit("connect");
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each([587, 465])("leaves TLS negotiation to Nodemailer on port %s", (port) => {
    const callback = vi.fn();
    connectSmtpSocket({ host: "smtp.example.com", port }, callback);
    expect(createConnection).toHaveBeenCalledWith({ host: "smtp.example.com", port });
    socket.emit("connect");
    expect(callback).toHaveBeenCalledWith(null, { connection: socket });
    expect(callback.mock.calls[0]![1]).not.toHaveProperty("secured");
    vi.advanceTimersByTime(10_000);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("reports resolver failures without exposing connection details", () => {
    const callback = vi.fn();
    connectSmtpSocket({ host: "smtp.example.com", port: 587 }, callback);
    socket.emit("error", Object.assign(new Error("private DNS diagnostic"), { code: "ENOTFOUND" }));
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: "ECONNECTION" }), false);
    expect(callback.mock.calls[0]![0].message).toBe("SMTP connection failed.");
    expect(socket.destroy).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    expect(callback).toHaveBeenCalledOnce();
  });
});
