"use strict";

const denied = () => {
  const error = new Error("MC_AWS_BUILD_NETWORK_DENIED");
  error.code = "MC_AWS_BUILD_NETWORK_DENIED";
  throw error;
};

const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const dgram = require("node:dgram");
const http2 = require("node:http2");

net.connect = denied;
net.createConnection = denied;
net.Socket.prototype.connect = denied;
tls.connect = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
dns.lookup = denied;
dns.resolve = denied;
dns.resolve4 = denied;
dns.resolve6 = denied;
dgram.createSocket = denied;
http2.connect = denied;
globalThis.fetch = async () => denied();
