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
    vistaActual: 'pulsador', // 'pulsador', 'espera', 'web'
    urlActual: '', 
    urlsGuardadas: ['', '', ''], 
    // AQUÍ ESTÁ EL CAMBIO: Ya busca la foto por defecto
    escenas: { espera: 'espera.jpg' },
    pulsadorActivo: false,
    colaPulsador: [],
    bloqueoGlobal: false
};

console.log("🚀 SERVIDOR LISTO - VERSIÓN FINAL APP CON FONDO AUTO");

io.on('connection', (socket) => {
    // Enviar estado inicial
    socket.emit('init_connection', { juegoIniciado, estadoJuego, equipos });

    // --- ZONA ADMIN ---
    socket.on('login_admin', (pin) => {
        if (String(pin).trim() === ADMIN_PIN) {
            socket.emit('admin_auth_success', { equipos, estadoJuego, juegoIniciado });
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
        juegoIniciado = false; equipos = []; estadoJuego.colaPulsador = [];
        io.emit('reset_total_client');
    });

    // --- ZONA JUGADORES ---
    socket.on('join_team', (data) => {
        const equipo = equipos.find(e => e.id === data.id);
        if (equipo) {
            equipo.ocupado = true;
            equipo.socketId = socket.id;
            socket.equipoId = equipo.id; 

            socket.emit('login_success', { miEquipo: equipo, estado: estadoJuego, equiposRivales: equipos });
            io.emit('actualizar_admin_equipos', equipos);
        }
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
            if (equipo) {
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
