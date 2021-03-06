const Discord = require('discord.js');
const client = new Discord.Client();
var spawn = require('child_process').spawn;
var fs = require('fs');
var ServerLogLine = require('./ServerLogLine');
var Verifier = require('./Verifier');
var MCCommand = require('./MCCommand');
var DiscordCommand = require('./DiscordCommand');
var UserManager = require('./UserManager');

var MC_VERSION = "1.12";
var DO_SEND_TO_CHANNEL = true;
var DO_SEND_ALERTS = false;
var CHANGE_NICKNAME = false; // discord changes back the nickname so the names are removed from the log
var BOT_NAME = "mc-bot";
var BOT_ICON = "VoHiYo.png";
var SERVER_CHANNEL = "mute-this-one";

var serverInstance;

var timeQueryQueue = [];
var sleepTimerId = -1;

var resetNameTimerId = -1;

var userManager = new UserManager("verifiedUsers.json");

client.login(fs.readFileSync("token.txt", 'utf8'));

client.on('ready', function() {
    console.log('discord app init');

    // reset changeable things in case server shut off before it changed back
    client.guilds.array()[0].members.get(client.user.id).setNickname(BOT_NAME);
    client.user.setAvatar(BOT_ICON);

    process.chdir("mcserver");
    // serverInstance = spawn("java", ["-Dlog4j.configurationFile=alldebug.xml", "-jar", "minecraft_server." + MC_VERSION + ".jar", "nogui"]);
    serverInstance = spawn("./ServerStart.sh");
    process.chdir("../");

    serverInstance.stdout.on('data', function(stdout) {
        var out = stdout.toString().trim().split("\n");

        for (var i = 0; i < out.length; i++) { // sometimes one line is actually more than one line
            var logLine = new ServerLogLine(out[i]);

            switch (logLine.logType) {
                case ServerLogLine.LogType.PLAYER_MESSAGE:
                    if (CHANGE_NICKNAME) {
                        sendToServerChannel(logLine.content, logLine.user);
                    } else {
                        sendToServerChannel("[" + logLine.timestamp + "] **<" + logLine.user + ">** " + logLine.content);
                    }
                    break;
                case ServerLogLine.LogType.SERVER_START:
                    var message = "The server was just launched! If you do not wish to receive push notifications for server events, disable notifications for the " + SERVER_CHANNEL + " channel in Notification Settings at the top left. To talk to players on the server, simply send a message in this channel.";
                    if (DO_SEND_ALERTS) {
                        message = "@everyone " + message;
                    }
                    sendToServerChannel(message);
                    break;
                case ServerLogLine.LogType.SERVER_STOP:
                    sendToServerChannel("The server has been stopped.");
                    break;
                case ServerLogLine.LogType.PLAYER_JOIN:
                    sendToServerChannel(logLine.content + "!");
                    break;
                case ServerLogLine.LogType.PLAYER_LEAVE:
                    sendToServerChannel(logLine.content + ".");
                    break;
                case ServerLogLine.LogType.PLAYER_DEATH:
                    sendToServerChannel(logLine.content);
                    break;
                case ServerLogLine.LogType.PACKET:
                    if (logLine.content.includes("PLAY:47")) { // use bed
                        var sleepTitle = {
                            text: "A player is attempting to sleep...",
                            italic: true
                        };
                        serverInstance.stdin.write("title @a actionbar " + JSON.stringify(sleepTitle) + "\n");

                        // notify discord users if someone slept and its daytime now
                        if (sleepTimerId != -1) { // reset if existing (maintains efficiency because first in bed waits for last in bed - only fails if someone is sleeping, someone else starts sleeping and resets it and then logs out)
                            clearInterval(sleepTimerId);
                        }
                        var count = 0;
                        sleepTimerId = setInterval(function() { // check for day every .5 seconds
                            count++;
                            getServerTime(function (time) {
                                if (time < 13000) {
                                    // TODO only send if someone logged out right before?
                                    sendToServerChannel(":sun_with_face: :sun_with_face: It's daytime now! :sun_with_face: :sun_with_face:");
                                    clearInterval(sleepTimerId);
                                    sleepTimerId = -1;
                                }
                            });
                            if (count > 120) { // wait 60 seconds before they give up on sleeping
                                clearInterval(sleepTimerId);
                                sleepTimerId = -1;
                            }
                        }, 500);
                    }
                    break;
                case ServerLogLine.LogType.TIME_UPDATE:
                    console.log("time update");
                    timeQueryQueue.pop()(logLine.content);
                    break;
                case ServerLogLine.LogType.COMMAND:
                    var command = new MCCommand(logLine.user, logLine.content);
                    console.log("command: " + command.content);
                    switch (command.title) {
                        case "verify":
                            if (userManager.getVerifiedUserByMCUser(command.user) != null) {
                                printToServerAsServer("You are already verified!");
                                break;
                            }
                            if (command.args.length != 1) {
                                printToServerAsServer("Invalid usage: type '#verify' in discord to start the verification process.");
                                break;
                            }
                            var verifier = userManager.getPendingVerifierByToken(command.args[0]);
                            if (verifier != null) {
                                if (command.args[0] == verifier.token) {
                                    verifier.addMCUser(command.user);
                                    userManager.finishVerification(verifier);
                                    printToServerAsServer("You have been verified!");
                                }
                            } else {
                                printToServerAsServer("Invalid token. Type '#verify' in discord to start the verification process.");
                            }
                            break;
                        default:
                            printToServerAsServer("Invalid command.");
                            break;
                    }
                    break;
            }
        }
    });

    serverInstance.stderr.on('data', function(stderr) {
        console.log(stderr.toString().trim());
    });

    serverInstance.on('exit', function(exitCode) {
        console.log("server exit with code: " + exitCode.toString().trim());
    });
});

client.on('message', function(message) {
    if (message.content.startsWith(DiscordCommand.COMMAND_SIGNAL)) {
        var command = new DiscordCommand(message.content);
        switch (command.title) {
            case "verify":
                if (command.args.length != 0) {
                    message.channel.send("Invalid usage: type '#verify' to start the verification process.");
                    break;
                }
                if (userManager.getVerifiedUserByDiscordUser(message.author.username) == null) {
                    if (userManager.getPendingVerifierByDiscordUser(message.author.user) == null) {
                        var verifier = new Verifier();
                        verifier.addDiscorUser(message.author.username);
                        userManager.startVerification(verifier);

                        if (message.channel.type != "dm") {
                            message.channel.send("The verification process has been started! Your verification code has been sent.")
                        }
                        message.author.send("Your verification code is: `" + verifier.token + "`\n\n" +
                            "In minecraft, type '#verify " + verifier.token + "' to confirm your username.");
                    } else {
                        message.channel.send("You are already in the process of being verified! Check your DMs for more information.");
                    }
                } else {
                    message.channel.send("You are already verified! :ok_hand:");
                }
                break;
        }
    } else {
        if (message.channel.name == SERVER_CHANNEL && message.author.username != "mc-bot") {
            var output = [{
                text: "@" + message.author.username + ":",
                hoverEvent: {
                    action: "show_text",
                    value: "From Discord"
                },
                bold: false,
                color: "aqua"
            }, {
                text: " " + message.content
            }];
            printToServer(output);
        }
    }
});

function printToServerAsServer(message) {
    var toSend = [{
        text: "[Server] " + message
    }];
    printToServer(toSend, "@a");
}

function printToServer(toSend, selector) {
    if (selector == undefined) {
        selector = "@a";
    }
    var emptyList = [""];
    toSend = emptyList.concat(toSend);
    serverInstance.stdin.write("tellraw " + selector + " " + JSON.stringify(toSend) + "\n");
}

function getChannel(channelName) {
    var channels = client.channels.array();
    for (var channel in channels) {
        if (channels[channel].name == channelName) {
            return channels[channel];
        }
    }
    return undefined;
}

function getServerTime(callback) {
    serverInstance.stdin.write("time query daytime\n");
    timeQueryQueue.push(callback);
}

function sendToServerChannel(message, as) {
    var bot = client.guilds.array()[0].members.get(client.user.id);
    if (DO_SEND_TO_CHANNEL) {
        var channel = getChannel(SERVER_CHANNEL);
        if (CHANGE_NICKNAME) {
            if (as != undefined) {
                if (bot.nickname != as) {
                    bot.setNickname(as).then(function() {
                        channel.send(message);
                    });
                } else { // if the nickname is still the same don't change again (reduces chat lag)
                    channel.send(message);
                }

                if (resetNameTimerId != -1) {
                    clearTimeout(resetNameTimerId);
                }
                resetNameTimerId = setTimeout(function() {
                    bot.setNickname(BOT_NAME);
                    resetNameTimerId = -1;
                }, 5 * 1000);
            } else {
                channel.send(message);
            }

        } else {
            channel.send(message);
        }
    } else {
        console.log("WOULD SEND TO CHANNEL: " + message);
    }
}