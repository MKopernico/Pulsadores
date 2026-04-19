const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

app.use(express.static('public'));

// --- CLAVE MAESTRA ---
const ADMIN_PIN = "6174"; 

// --- ESTADO DEL JUEGO ---
let juegoIniciado = false;
let equipos = []; 
// Modelo equipo: { id, nombre, ocupado, bonos: [], bloqueado: false, socketId }

let estadoJuego = {
    vistaActual: 'pulsador', // 'pulsador', 'espera', 'web', 'precio'
    urlActual: '',
    urlsGuardadas: ['', '', ''],
    escenas: { espera: '' },
    pulsadorActivo: false,
    colaPulsador: [],
    bloqueoGlobal: false,
    precio: {
        tiempoSegundos: 30,
        tiempoInicio: null,      // Date.now() cuando arranca la cuenta atrás
        respuestas: {},           // { equipoId: { valor, tiempo } }
        fase: 'config',           // 'config' | 'jugando' | 'resultado'
        ganadorId: null,
        cifraCorrecta: null       // expuesta a todos SOLO en fase 'resultado'
    }
};

// Cifra correcta del Precio Justo: nunca viaja dentro de estadoJuego para que no llegue a los jugadores mientras juegan.
let precioCifraCorrecta = null;
let precioTimeoutHandle = null;

console.log("🚀 SERVIDOR LISTO - VERSIÓN FINAL APP");

// --- HEALTH-CHECK ---
// Endpoint usado por el keepalive del panel admin: Render duerme el servicio sin tráfico HTTP y los WebSocket no cuentan.
app.get('/ping', (req, res) => res.send('ok'));

// Cierra la ronda actual de Precio Justo: calcula ganador y emite resultado a todos.
function finalizarPrecio() {
    if (precioTimeoutHandle) { clearTimeout(precioTimeoutHandle); precioTimeoutHandle = null; }
    estadoJuego.precio.fase = 'resultado';
    estadoJuego.precio.cifraCorrecta = precioCifraCorrecta;

    const cifra = precioCifraCorrecta;
    // Se descarta a quien se pasa. Gana el más alto por debajo (o exacto); desempate por timestamp más temprano.
    const ordenados = Object.entries(estadoJuego.precio.respuestas)
        .filter(([, r]) => r.valor <= cifra)
        .sort((a, b) => {
            if (b[1].valor !== a[1].valor) return b[1].valor - a[1].valor;
            return a[1].tiempo - b[1].tiempo;
        });
    estadoJuego.precio.ganadorId = ordenados.length > 0 ? ordenados[0][0] : null;

    io.emit('precio_resultado', {
        cifraCorrecta: cifra,
        respuestas: estadoJuego.precio.respuestas,
        ganadorId: estadoJuego.precio.ganadorId
    });
    io.emit('sync_estado', estadoJuego);
}

io.on('connection', (socket) => {
    // Enviar estado inicial
    socket.emit('init_connection', { juegoIniciado, estadoJuego, equipos });

    // --- ZONA ADMIN ---
    socket.on('login_admin', (pin) => {
        if (String(pin).trim() === ADMIN_PIN) {
            socket.emit('admin_auth_success', { equipos, estadoJuego, juegoIniciado, precioCifra: precioCifraCorrecta });
        } else {
            socket.emit('admin_auth_fail');
        }
    });

    socket.on('admin_crear_juego', (n) => {
        equipos = [];
        for (let i = 1; i <= n; i++) {
            equipos.push({ 
                id: `eq${i}`, nombre: `Equipo ${i}`, ocupado: false, 
                bonos: [], bloqueado: false 
            });
        }
        juegoIniciado = true;
        estadoJuego.colaPulsador = [];
        estadoJuego.bloqueoGlobal = false;
        estadoJuego.pulsadorActivo = false;
        
        io.emit('juego_iniciado_teams', equipos);
        io.emit('sync_estado', estadoJuego);
    });

    // RENOMBRAR EQUIPO
    socket.on('admin_rename_team', (data) => {
        const eq = equipos.find(e => e.id === data.id);
        if (eq) {
            eq.nombre = data.nuevoNombre;
            io.emit('actualizar_admin_equipos', equipos);
            io.emit('juego_iniciado_teams', equipos);
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        }
    });

    socket.on('admin_control_pulsador', (acc) => {
        if (acc === 'abrir') estadoJuego.pulsadorActivo = true;
        if (acc === 'pausar') estadoJuego.pulsadorActivo = false;
        if (acc === 'reset') { estadoJuego.pulsadorActivo = false; estadoJuego.colaPulsador = []; }
        io.emit('estado_pulsador_cambio', { activo: estadoJuego.pulsadorActivo, cola: estadoJuego.colaPulsador });
    });

    socket.on('admin_config_escenas', (data) => {
        estadoJuego.escenas.espera = data.espera;
        io.emit('sync_estado', estadoJuego); 
        if (estadoJuego.vistaActual === 'espera') io.emit('cambio_de_escena', estadoJuego);
    });

    socket.on('admin_set_escena', (d) => {
        estadoJuego.vistaActual = d.vista;
        if (d.vista === 'web' && d.url) estadoJuego.urlActual = d.url;
        if (d.saveSlot !== undefined && d.urlToSave) estadoJuego.urlsGuardadas[d.saveSlot] = d.urlToSave;
        io.emit('cambio_de_escena', estadoJuego);
    });

    // --- PODERES Y BLOQUEOS ---
    socket.on('admin_gestionar_bono', (data) => {
        const eq = equipos.find(e => e.id === data.equipoId);
        if (eq) {
            if (data.accion === 'add') eq.bonos.push(data.tipo);
            else if (data.accion === 'remove') {
                const index = eq.bonos.indexOf(data.tipo);
                if (index > -1) eq.bonos.splice(index, 1);
            }
            io.emit('actualizar_admin_equipos', equipos);
            if(eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        }
    });

    socket.on('admin_toggle_bloqueo', (data) => {
        const eq = equipos.find(e => e.id === data.equipoId);
        if (eq) {
            eq.bloqueado = data.bloqueado;
            io.emit('actualizar_admin_equipos', equipos);
            if(eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        }
    });

    socket.on('admin_toggle_global_lock', (valor) => {
        estadoJuego.bloqueoGlobal = valor;
        io.emit('sync_estado', estadoJuego);
    });

    socket.on('admin_reset_total', () => {
        if (precioTimeoutHandle) { clearTimeout(precioTimeoutHandle); precioTimeoutHandle = null; }
        juegoIniciado = false; equipos = []; estadoJuego.colaPulsador = [];
        estadoJuego.precio = { tiempoSegundos: 30, tiempoInicio: null, respuestas: {}, fase: 'config', ganadorId: null, cifraCorrecta: null };
        precioCifraCorrecta = null;
        io.emit('reset_total_client');
    });

    // --- PRECIO JUSTO ---
    socket.on('admin_precio_set_cifra', (valor) => {
        const n = Number(valor);
        if (!isFinite(n)) return;
        precioCifraCorrecta = n;
        socket.emit('admin_precio_cifra_sync', precioCifraCorrecta);
    });

    socket.on('admin_precio_set_tiempo', (segundos) => {
        const n = Number(segundos);
        if (!isFinite(n) || n < 5) return;
        estadoJuego.precio.tiempoSegundos = Math.round(n);
        io.emit('sync_estado', estadoJuego);
    });

    socket.on('admin_precio_nueva_partida', () => {
        if (precioTimeoutHandle) { clearTimeout(precioTimeoutHandle); precioTimeoutHandle = null; }
        estadoJuego.precio.respuestas = {};
        estadoJuego.precio.tiempoInicio = null;
        estadoJuego.precio.fase = 'config';
        estadoJuego.precio.ganadorId = null;
        estadoJuego.precio.cifraCorrecta = null;
        io.emit('sync_estado', estadoJuego);
    });

    socket.on('admin_precio_iniciar', () => {
        if (precioCifraCorrecta === null) {
            socket.emit('notificacion_bono', { msg: "❌ Define una cifra antes de comenzar" });
            return;
        }
        if (precioTimeoutHandle) { clearTimeout(precioTimeoutHandle); precioTimeoutHandle = null; }
        estadoJuego.precio.respuestas = {};
        estadoJuego.precio.tiempoInicio = Date.now();
        estadoJuego.precio.fase = 'jugando';
        estadoJuego.precio.ganadorId = null;
        estadoJuego.precio.cifraCorrecta = null;
        precioTimeoutHandle = setTimeout(finalizarPrecio, estadoJuego.precio.tiempoSegundos * 1000);
        io.emit('sync_estado', estadoJuego);
    });

    socket.on('admin_precio_forzar_resultado', () => {
        if (estadoJuego.precio.fase === 'jugando') finalizarPrecio();
    });

    socket.on('precio_enviar_respuesta', (data) => {
        if (estadoJuego.precio.fase !== 'jugando') return;
        const eq = equipos.find(e => e.id === socket.equipoId);
        if (!eq) return;
        const valor = Number(data && data.valor);
        if (!isFinite(valor)) return;
        if (estadoJuego.precio.respuestas[eq.id]) return; // una respuesta por ronda
        estadoJuego.precio.respuestas[eq.id] = { valor, tiempo: Date.now() };
        io.emit('sync_estado', estadoJuego);
    });

    // --- ZONA JUGADORES ---
    socket.on('join_team', (data) => {
        const equipo = equipos.find(e => e.id === data.id);
        if (!equipo) return;

        // Si hay otro socket vivo dueño del equipo, rechazar. Si el anterior está muerto (reconexión tras caída), permitir takeover.
        if (equipo.ocupado && equipo.socketId && equipo.socketId !== socket.id) {
            const prevSocket = io.sockets.sockets.get(equipo.socketId);
            if (prevSocket && prevSocket.connected) {
                socket.emit('join_team_rejected', { motivo: 'ocupado', equipoId: equipo.id });
                return;
            }
        }

        equipo.ocupado = true;
        equipo.socketId = socket.id;
        socket.equipoId = equipo.id;

        socket.emit('login_success', { miEquipo: equipo, estado: estadoJuego, equiposRivales: equipos });
        io.emit('actualizar_admin_equipos', equipos);
    });

    socket.on('pulsar_boton', () => {
        const e = equipos.find(x => x.id === socket.equipoId);
        if (e && estadoJuego.pulsadorActivo && !estadoJuego.bloqueoGlobal && !e.bloqueado) {
            if (!estadoJuego.colaPulsador.find(p => p.id === e.id)) {
                estadoJuego.colaPulsador.push({ id: e.id, nombre: e.nombre, tiempo: Date.now() });
                // EMISION INSTANTANEA
                io.emit('actualizar_pulsador_lista', estadoJuego.colaPulsador);
            }
        }
    });

    socket.on('usar_bono', (data) => {
        const emisor = equipos.find(e => e.id === socket.equipoId);
        if (emisor && emisor.bonos.includes(data.tipo)) {
            let mensaje = "";
            if (data.tipo === 'lock_all') {
                equipos.forEach(eq => {
                    if (eq.id !== emisor.id) { 
                        eq.bloqueado = true;
                        if(eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
                    }
                });
                io.emit('actualizar_admin_equipos', equipos);
                mensaje = `⛔ ${emisor.nombre} BLOQUEÓ A RIVALES`;
            } 
            else if (data.tipo === 'freeze') {
                let victima = equipos.find(e => e.id === data.targetId);
                if(!victima && data.targetNumero) victima = equipos.find(e => e.id === `eq${data.targetNumero}`);
                
                if (victima) {
                    if(victima.id === emisor.id) {
                         socket.emit('notificacion_bono', { msg: "❌ No te puedes congelar a ti mismo" });
                         return;
                    }
                    victima.bloqueado = true;
                    mensaje = `❄️ ${emisor.nombre} CONGELÓ A ${victima.nombre}`;
                    io.emit('actualizar_admin_equipos', equipos);
                    if(victima.socketId) io.to(victima.socketId).emit('update_mi_equipo', victima);
                } else {
                    socket.emit('notificacion_bono', { msg: "❌ Equipo no encontrado" });
                    return; 
                }
            }
            const idx = emisor.bonos.indexOf(data.tipo);
            if(idx > -1) emisor.bonos.splice(idx, 1);
            socket.emit('update_mi_equipo', emisor); 
            io.emit('notificacion_bono', { msg: mensaje }); 
        }
    });

    // --- RECONEXIÓN ---
    socket.on('disconnect', () => {
        if (socket.equipoId) {
            const equipo = equipos.find(e => e.id === socket.equipoId);
            // Solo liberar si este socket sigue siendo el dueño (evita pisar una toma de control ya hecha por otro socket).
            if (equipo && equipo.socketId === socket.id) {
                equipo.ocupado = false;
                io.emit('actualizar_admin_equipos', equipos);
            }
        }
    });
});

// ARRANQUE ROBUSTO
const port = process.env.PORT || 3000;
const listener = http.listen(port, '0.0.0.0', () => {
    console.log(`✅ Servidor ON: Puerto ${listener.address().port}`);
});
listener.on('error', (e) => { if (e.code === 'EADDRINUSE') process.exit(1); });
