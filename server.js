require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Límite de tamaño para recibir imágenes en Base64
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use('/uploads', express.static('uploads'));

// ==========================================
// 1. AUTENTICACIÓN
// ==========================================

// Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        }

        res.json({
            success: true,
            message: 'Inicio de sesión exitoso',
            userId: user.id,
            nombre: user.nombre,
            email: user.email,
            rol: user.rol,
            fotoPerfil: user.foto_perfil
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error en el servidor: ' + err.message });
    }
});

// Registro
app.post('/api/registro', async (req, res) => {
    const { nombre, email, password, rol } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const query = 'INSERT INTO usuarios (nombre, email, password, rol) VALUES ($1, $2, $3, $4) RETURNING id';
        const result = await pool.query(query, [nombre, email, hashedPassword, rol || 'cliente']);

        res.json({
            success: true,
            message: 'Usuario registrado con éxito',
            userId: result.rows[0].id
        });
    } catch (err) {
        res.status(400).json({ success: false, message: 'El correo ya está registrado o hubo un error' });
    }
});

// ==========================================
// 2. PRODUCTOS Y CATÁLOGO
// ==========================================

app.get('/api/productos', async (req, res) => {
    try {
        const query = `
            SELECT p.id, p.nombre, p.descripcion, p.precio, p.stock, p.imagen_url AS "imagenUrl", c.nombre AS "categoriaNombre" 
            FROM productos p 
            LEFT JOIN categorias c ON p.categoria_id = c.id
            ORDER BY p.id ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/productos', async (req, res) => {
    const { nombre, descripcion, precio, stock, categoria_id, imagen_url } = req.body;
    try {
        const query = 'INSERT INTO productos (nombre, descripcion, precio, stock, categoria_id, imagen_url) VALUES ($1, $2, $3, $4, $5, $6)';
        await pool.query(query, [nombre, descripcion, precio, stock, categoria_id || 1, imagen_url || 'https://via.placeholder.com/150']);
        res.json({ success: true, message: 'Producto creado exitosamente' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error al crear producto' });
    }
});

app.put('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, descripcion, precio, stock, imagen_url } = req.body;
    try {
        const query = 'UPDATE productos SET nombre = $1, descripcion = $2, precio = $3, stock = $4, imagen_url = $5 WHERE id = $6';
        await pool.query(query, [nombre, descripcion, precio, stock, imagen_url, id]);
        res.json({ success: true, message: 'Producto actualizado' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error al actualizar producto' });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM productos WHERE id = $1', [id]);
        res.json({ success: true, message: 'Producto eliminado' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error al eliminar producto' });
    }
});

app.get('/api/categorias', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM categorias ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ==========================================
// 3. PEDIDOS
// ==========================================

app.post('/api/pedidos', async (req, res) => {
    const { usuarioId, items, total } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const queryPedido = 'INSERT INTO pedidos (usuario_id, total, estado) VALUES ($1, $2, $3) RETURNING id';
        const resultPedido = await client.query(queryPedido, [usuarioId, total, 'PENDIENTE']);
        const pedidoId = resultPedido.rows[0].id;

        const queryItem = 'INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES ($1, $2, $3, $4)';
        for (const item of items) {
            await client.query(queryItem, [pedidoId, item.productoId, item.cantidad, item.precioUnitario]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Pedido realizado con éxito', pedidoId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: 'Error al procesar el pedido: ' + err.message });
    } finally {
        client.release();
    }
});

app.get('/api/pedidos/usuario/:usuarioId', async (req, res) => {
    const { usuarioId } = req.params;
    try {
        const query = `
            SELECT 
                p.id, 
                p.usuario_id AS "usuarioId", 
                COALESCE(u.nombre, 'Usuario ' || p.usuario_id) AS "usuarioNombre",
                TO_CHAR(p.fecha, 'YYYY-MM-DD HH24:MI') AS fecha, 
                p.total, 
                p.estado 
            FROM pedidos p 
            LEFT JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.usuario_id = $1 
            ORDER BY p.id DESC
        `;
        const result = await pool.query(query, [usuarioId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/pedidos', async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id, 
                p.usuario_id AS "usuarioId", 
                COALESCE(u.nombre, 'Cliente #' || p.usuario_id) AS "usuarioNombre",
                TO_CHAR(p.fecha, 'YYYY-MM-DD HH24:MI') AS fecha, 
                p.total, 
                p.estado 
            FROM pedidos p 
            LEFT JOIN usuarios u ON p.usuario_id = u.id 
            ORDER BY p.id DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/pedidos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const queryPedido = `
            SELECT 
                p.id, 
                p.usuario_id AS "usuarioId",
                COALESCE(u.nombre, 'Cliente #' || p.usuario_id) AS "usuarioNombre",
                TO_CHAR(p.fecha, 'YYYY-MM-DD HH24:MI') AS fecha, 
                p.total, 
                p.estado 
            FROM pedidos p 
            LEFT JOIN usuarios u ON p.usuario_id = u.id 
            WHERE p.id = $1
        `;
        const resultPedido = await pool.query(queryPedido, [id]);

        if (resultPedido.rows.length === 0) {
            return res.status(404).json({ message: 'Pedido no encontrado' });
        }

        const queryItems = `
            SELECT p.nombre AS "productoNombre", dp.cantidad, dp.precio_unitario AS "precioUnitario" 
            FROM detalle_pedidos dp 
            JOIN productos p ON dp.producto_id = p.id 
            WHERE dp.pedido_id = $1
        `;
        const resultItems = await pool.query(queryItems, [id]);

        const pedido = resultPedido.rows[0];
        pedido.items = resultItems.rows;

        res.json(pedido);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.put('/api/pedidos/:id/estado', async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    try {
        const result = await pool.query('UPDATE pedidos SET estado = $1 WHERE id = $2 RETURNING *', [estado, id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
        }

        res.json({ success: true, message: 'Estado actualizado correctamente' });
    } catch (err) {
        console.error('Error al actualizar estado:', err.message);
        res.status(500).json({ success: false, message: 'Error al cambiar estado: ' + err.message });
    }
});

// ==========================================
// 4. USUARIOS
// ==========================================

// Obtener usuarios con fecha de registro incluida (Vista Admin)
app.get('/api/usuarios', async (req, res) => {
    try {
        const query = `
            SELECT 
                id, 
                nombre, 
                email, 
                rol, 
                foto_perfil AS "fotoPerfil",
                TO_CHAR(fecha_registro, 'YYYY-MM-DD HH24:MI') AS "fechaRegistro"
            FROM usuarios 
            ORDER BY id ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Actualización por parte del perfil del propio usuario
app.put('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, fotoPerfil } = req.body;
    try {
        await pool.query(
            'UPDATE usuarios SET nombre = $1, email = $2, foto_perfil = $3 WHERE id = $4',
            [nombre, email, fotoPerfil, id]
        );
        res.json({ success: true, message: 'Perfil actualizado' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error al actualizar perfil' });
    }
});

// Cambio de contraseña del propio usuario
app.put('/api/usuarios/:id/password', async (req, res) => {
    const { id } = req.params;
    const { passwordActual, nuevaPassword } = req.body;
    try {
        const result = await pool.query('SELECT password FROM usuarios WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Usuario no encontrado' });
        }

        const match = await bcrypt.compare(passwordActual, result.rows[0].password);
        if (!match) {
            return res.status(400).json({ success: false, message: 'La contraseña actual no coincide' });
        }

        const newHashed = await bcrypt.hash(nuevaPassword, 10);
        await pool.query('UPDATE usuarios SET password = $1 WHERE id = $2', [newHashed, id]);
        res.json({ success: true, message: 'Contraseña actualizada' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error al actualizar la contraseña' });
    }
});

// Actualización COMPLETA desde el panel Admin
app.put('/api/usuarios/admin/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, rol, fotoPerfil, nuevaPassword } = req.body;
    try {
        if (nuevaPassword && nuevaPassword.trim() !== '') {
            const hashedPassword = await bcrypt.hash(nuevaPassword, 10);
            await pool.query(
                'UPDATE usuarios SET nombre = $1, email = $2, rol = $3, foto_perfil = $4, password = $5 WHERE id = $6',
                [nombre, email, rol, fotoPerfil, hashedPassword, id]
            );
        } else {
            await pool.query(
                'UPDATE usuarios SET nombre = $1, email = $2, rol = $3, foto_perfil = $4 WHERE id = $5',
                [nombre, email, rol, fotoPerfil, id]
            );
        }
        res.json({ success: true, message: 'Usuario actualizado correctamente' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error al actualizar usuario: ' + err.message });
    }
});

// Eliminar usuario desde el panel Admin
app.delete('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
        res.json({ success: true, message: 'Usuario eliminado correctamente' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error al eliminar usuario. Verifique si tiene pedidos asociados.' });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});