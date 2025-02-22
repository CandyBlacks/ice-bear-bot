/* ========================================================================== */
/* CLASSE QUE IMPLEMENTA A REPRODUÇÃO DE MÚSICAS                              */
/* -------------------------------------------------------------------------- */
/* Autor: Victor Barpp Gomes                                                  */
/* Data: 2019/01/14                                                           */
/* ========================================================================== */

const Discord = require("discord.js");
const moment = require("moment");
const ytdl = require("ytdl-core");

const MusicQueueItem = require("./music-queue-item.js");
const MusicSong = require("./music-song.js");

/* ========================================================================== */

// TODO: Verificar estas configs para melhorar a estabilidade da stream
const ytdlOptions = {
    quality: "highestaudio",
    highWaterMark: 1 << 25,
};

const MAX_AUTOPLAY_HISTORY = 25;

/* ========================================================================== */

/**
 * Esta classe representa a instância de um player de músicas em um servidor.
 */
class MusicPlayer {

    /**
     * Construtor.
     * @param {Discord.Snowflake} guildId ID do servidor
     */
    constructor(guildId, musicController) {
        /** ID do servidor em que este player está sendo executado.
         * @type {Discord.Snowflake}
         */
        this.guildId = guildId;

        /** Referência ao controlador de musicas
         * @type {MusicController}
         */
        this.musicController = musicController;

        /** Canal de texto atual (no qual o bot enviará as mensagens a cada
         * troca de música, por exemplo)
         * @type {Discord.TextChannel}
         */
        this.textChannel = null;

        /** Voice connection, usada para reproduzir arquivos de áudio.
         * @type {Discord.VoiceConnection}
         */
        this.voiceConnection = null;

        /** Dispatcher, usado para transmitir uma stream de áudio.
         * @type {Discord.StreamDispatcher}
         */
        this.dispatcher = null;

        /** Volume, de 0.0 a 1.0.
         * @type {number}
         */
        this.volume = 1.0;

        /** Flag que mostra se o player está reproduzindo alguma música.
         * @type {boolean}
         */
        this.isPlaying = false;

        /** Música que está tocando no momento.
         * @type {MusicQueueItem}
         */
        this.currentSong = null;

        /** Flag que mostra se o player está em modo autoplay.
         * @type {boolean}
         */
        this.isAutoPlaying = false;

        /** Pequeno cache de Video IDs para evitar que o autoplay fique preso em
         * um ciclo.
         * @type {string[]}
         */
        this.latestAutoplay = [];

        /** Referência a um timeout para sair do servidor, iniciado quando o
         * player fica ocioso.
         * @type {NodeJS.Timeout}
         */
        this.leaveTimeout = null;

        /** Fila de musicas.
         * @type {MusicQueueItem[]}
         */
        this.queue = [];
    }

    /* ---------------------------------------------------------------------- */

    /** Vincula o player de músicas a um canal de texto. Todas as mensagens
     * autônomas do bot (ex: troca de música) serão enviadas nesse canal.
     * @param {Discord.TextChannel} textChannel canal de texto
     */
    setTextChannel(textChannel) {
        this.textChannel = textChannel;
    }

    /* ---------------------------------------------------------------------- */

    /**
     * Começa a reproduzir uma música. Caso seja necessário, conecta-se a um
     * voice channel.
     * 
     * @param {Discord.GuildMember} voice.channel membro que solicitou uma música
     * @param {MusicSong} song música a reproduzir
     */
    startPlaying(member, song) {
        const voiceChannel = member.voice.channel;
        const player = this;

        this.currentSong = new MusicQueueItem(member, song);

        if (!player.voiceConnection || (player.voiceConnection.channel.id !== voiceChannel.id)) {
            voiceChannel.join().then(connection => {
                player.voiceConnection = connection;
                player.playYouTube(song);
            }).catch(console.log);
        }
        else {
            player.playYouTube(song);
        }
    }

    /* ---------------------------------------------------------------------- */

    /**
     * Reproduz um arquivo de áudio no voice channel atual. Supõe que o bot está
     * em um voice channel.
     * Interrompe o timer de ociosidade.
     * 
     * @param {MusicSong} song música a reproduzir
     * @private
     */
    playYouTube(song) {
        const stream = ytdl(this.getYtUrl(song.id), ytdlOptions);

        console.log("Now playing: " + song.title);

        // const dispatcher = this.voiceConnection.playFile(filePath);
        this.dispatcher = this.voiceConnection.playStream(stream);
        this.dispatcher.setVolume(this.volume);

        if (this.leaveTimeout) {
            clearTimeout(this.leaveTimeout);
            this.leaveTimeout = null;
        }
        this.isPlaying = true;

        this.sendSongEmbed(song, ":arrow_forward: Now playing", this.currentSong.user.displayName);

        this.dispatcher.on("end", reason => {
            MusicPlayer.onSongEnd(this);
            if (reason) console.log(reason);
        });
        this.dispatcher.on("error", e => {
            console.error(e);
        });
    }

    /* ---------------------------------------------------------------------- */

    skipCurrentSong() {
        if (!this.dispatcher || !this.isPlaying) return;

        const embed = new Discord.RichEmbed()
            .setColor(0x286ee0)
            .setTitle(":track_next: Skipping...");
        this.textChannel.send(embed);

        this.dispatcher.end("Received a skip command");
        // Isso emite um evento "end", que chama onSongEnd.
    }

    /* ---------------------------------------------------------------------- */

    setVolume(newVolume) {
        this.volume = newVolume;
        if (this.dispatcher !== null) {
            this.dispatcher.setVolume(newVolume);
        }
    }

    /* ---------------------------------------------------------------------- */

    /**
     * Função executada quando a execução de uma música termina.
     * Verifica se o bot está no modo auto-play ou se há mais itens na fila.
     * Se sim, inicia a reprodução do próximo item.
     * Senão, inicia o timer de ociosidade.
     * 
     * @param {MusicPlayer} player 
     */
    static onSongEnd(player) {
        // Isso é triste, mas aqui pode acontecer concorrência.
        player.lock.acquire("lock", () => {
            if (player.queue.length > 0) {
                const queueItem = player.queue.shift();

                player.currentSong = queueItem;
                player.playYouTube(queueItem.song);
                return;
            }

            if (player.isAutoPlaying) {
                const videoId = player.currentSong.song.id;
                player.latestAutoplay.push(videoId);
                while (player.latestAutoplay.length > MAX_AUTOPLAY_HISTORY) {
                    player.latestAutoplay.shift();
                }

                player.musicController.searchRelatedVideo(videoId, player.latestAutoplay)
                    .then(musicSong => {
                        const queueItem = new MusicQueueItem(null, musicSong);
                        queueItem.user.displayName = "Autoplay";

                        player.currentSong = queueItem;
                        player.playYouTube(queueItem.song);
                        console.log("Autoplay: " + queueItem.song.title);
                    })
                    .catch(err => {
                        console.error(err);
                        MusicPlayer.startLeaveTimeout(player);
                    });
                return;
            }

            // Se não há nenhuma música a reproduzir, inicia um timeout para o bot
            // sair do voice channel.
            MusicPlayer.startLeaveTimeout(player);
            // TODO: put timer miliseconds on config.json
        }).catch(console.error);
    }

    /* ---------------------------------------------------------------------- */

    static startLeaveTimeout(player) {
        player.isPlaying = false;
        player.currentSong = null;
        player.leaveTimeout = setTimeout(() => {
            player.musicController.dropPlayer(player);
        }, 10000);
    }

    /* ---------------------------------------------------------------------- */

    /**
     * Inclui uma música na fila de reprodução.
     * @param {Discord.GuildMember} member usuário que solicitou a música
     * @param {MusicSong} song 
     */
    enqueue(member, song) {
        this.queue.push(new MusicQueueItem(member, song));

        console.log("Song \"" + song.title + "\" enqueued by " + member.displayName);

        // Caso alguém coloque uma música enquanto está no modo autoplay, limpa
        // o histórico de autoplay.
        this.clearAutoplayHistory();

        this.sendSongEmbed(song, ":new: Song enqueued", member.displayName);
    }

    /* ---------------------------------------------------------------------- */

    getYtUrl(videoId) {
        return "https://www.youtube.com/watch?v=" + videoId;
    }

    /* ---------------------------------------------------------------------- */

    getDurationStr(duration) {
        const seconds = duration.seconds();
        const minutes = duration.minutes();
        const hours = Math.trunc((duration.asSeconds() - seconds - minutes * 60) / 3600);

        let durationStr = seconds.toString();
        if (seconds < 10) {
            durationStr = "0" + durationStr;
        }
        durationStr = minutes.toString() + ":" + durationStr;
        if (hours > 0) {
            if (minutes < 10) {
                durationStr = ":0" + durationStr;
            }
            durationStr = hours.toString() + durationStr;
        }

        return durationStr;
    }

    /* ---------------------------------------------------------------------- */

    sendSongEmbed(song, embedTitle, memberName) {
        const embed = new Discord.RichEmbed()
            .setColor(0x286ee0)
            .setTitle(embedTitle)
            .setDescription("[" + song.title + "](" + this.getYtUrl(song.id) + ")\n" +
                "**Channel:** " + song.channelTitle + "\n" +
                "**Duration:** " + this.getDurationStr(song.duration) + "\n" +
                "**Enqueued by:** " + memberName)
            .setThumbnail(song.thumbnail);
        this.textChannel.send(embed);
    }

    /* ---------------------------------------------------------------------- */

    sendCurrentSongEmbed() {
        const song = this.currentSong.song;
        const memberName = this.currentSong.user.displayName;
        const ytUrl = this.getYtUrl(song.id);
        const totalDuration = this.getDurationStr(song.duration);
        const timePlayed = this.getDurationStr(moment.duration(this.dispatcher.time));

        const embed = new Discord.RichEmbed()
            .setColor(0x286ee0)
            .setTitle("Current song")
            .setDescription("[" + song.title + "](" + ytUrl + ")\n" +
                "**Channel:** " + song.channelTitle + "\n" +
                "**Duration:** " + timePlayed + "/" + totalDuration + "\n" +
                "**Enqueued by:** " + memberName)
            .setThumbnail(song.thumbnail);
        this.textChannel.send(embed);
    }

    /* ---------------------------------------------------------------------- */

    sendQueueEmbed(page) {
        let start = (page - 1) * 10;
        let end = start + 10;
        if (end > this.queue.length) {
            end = this.queue.length;
        }
        if (start > end) {
            start = end - 1 - ((end - 1) % 10);
        }

        const items = this.queue.slice(start, end);

        let description = "";
        let position = start + 1;
        for (const queueItem of items) {
            description += "**" + position + "**: " + queueItem.song.title + "\n";
            ++position;
        }

        const embed = new Discord.RichEmbed()
            .setColor(0x286ee0)
            .setTitle("Queue")
            .setDescription(description)
            .setFooter("Page " + (Math.trunc(start / 10) + 1) + " of " + (Math.trunc((this.queue.length - 1) / 10) + 1));
        this.textChannel.send(embed);
    }

    /* ---------------------------------------------------------------------- */

    toggleAutoplay() {
        this.isAutoPlaying = !this.isAutoPlaying;
        this.clearAutoplayHistory();

        const embed = new Discord.RichEmbed()
            .setColor(0x286ee0)
            .setTitle("Autoplay is now " + ((this.isAutoPlaying) ? "*on*" : "*off*"));
        this.textChannel.send(embed);
    }

    /* ---------------------------------------------------------------------- */

    clearAutoplayHistory() {
        this.latestAutoplay.length = 0;
    }

    /* ---------------------------------------------------------------------- */

    /**
     * Interrompe qualquer execução de áudio em andamento e desconecta o player
     * do canal de voz no qual está conectado.
     */
    disconnect() {
        if (this.voiceConnection) {
            this.voiceConnection.disconnect();
        }
        this.voiceConnection = null;
    }

}

/* ========================================================================== */

module.exports = MusicPlayer;

/* ========================================================================== */
