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
            saldo: parseFloat(user.saldo || 0),
            fotoPerfil: user.foto_perfil || null
        });
    } catch (err) {
        console.error('Error en /api/login:', err);
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
        console.error('Error en /api/registro:', err);
        res.status(400).json({ success: false, message: 'El correo ya está registrado o hubo un error en los datos' });
    }
});

// ==========================================
// 2. PRODUCTOS Y CATÁLOGO
// ==========================================

app.get('/api/productos', async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id, 
                p.nombre, 
                p.descripcion, 
                CAST(p.precio AS DOUBLE PRECISION) AS precio, 
                p.stock, 
                p.categoria_id AS "categoriaId",
                p.imagen_url AS "imagenUrl", 
                c.nombre AS "categoriaNombre" 
            FROM productos p 
            LEFT JOIN categorias c ON p.categoria_id = c.id
            ORDER BY p.id ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Error en GET /api/productos:', err);
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/productos', async (req, res) => {
    const { nombre, descripcion, precio, stock, categoria_id, categoriaId, imagen_url, imagenUrl } = req.body;
    const catId = categoria_id || categoriaId || 1;
    const imgUrl = imagen_url || imagenUrl || 'https://via.placeholder.com/150';

    try {
        const query = 'INSERT INTO productos (nombre, descripcion, precio, stock, categoria_id, imagen_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id';
        const result = await pool.query(query, [nombre, descripcion, precio, stock, catId, imgUrl]);
        res.json({ success: true, message: 'Producto creado exitosamente', id: result.rows[0].id });
    } catch (err) {
        console.error('Error en POST /api/productos:', err);
        res.status(500).json({ success: false, message: 'Error al crear producto: ' + err.message });
    }
});

app.put('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, descripcion, precio, stock, categoria_id, categoriaId, imagen_url, imagenUrl } = req.body;
    const catId = categoria_id || categoriaId || 1;
    const imgUrl = imagen_url || imagenUrl || 'https://via.placeholder.com/150';

    try {
        const query = 'UPDATE productos SET nombre = $1, descripcion = $2, precio = $3, stock = $4, categoria_id = $5, imagen_url = $6 WHERE id = $7';
        await pool.query(query, [nombre, descripcion, precio, stock, catId, imgUrl, id]);
        res.json({ success: true, message: 'Producto actualizado' });
    } catch (err) {
        console.error('Error en PUT /api/productos:', err);
        res.status(500).json({ success: false, message: 'Error al actualizar producto: ' + err.message });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM productos WHERE id = $1', [id]);
        res.json({ success: true, message: 'Producto eliminado' });
    } catch (err) {
        console.error('Error en DELETE /api/productos:', err);
        res.status(500).json({ success: false, message: 'Error al eliminar producto' });
    }
});

app.get('/api/categorias', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM categorias ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error en GET /api/categorias:', err);
        res.status(500).json({ message: err.message });
    }
});

// ==========================================
// 3. PEDIDOS
// ==========================================

app.post('/api/pedidos', async (req, res) => {
    const { usuarioId, usuario_id, items, total } = req.body;
    const idUsuario = usuarioId || usuario_id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Consultar saldo actual del usuario en base de datos
        const resUser = await client.query('SELECT saldo FROM usuarios WHERE id = $1', [idUsuario]);
        if (resUser.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }

        const saldoActual = parseFloat(resUser.rows[0].saldo || 0);
        const totalCompra = parseFloat(total);

        // 2. Verificar saldo disponible
        if (saldoActual < totalCompra) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Saldo insuficiente en la cuenta' });
        }

        // 3. Descontar saldo al usuario
        const nuevoSaldo = saldoActual - totalCompra;
        await client.query('UPDATE usuarios SET saldo = $1 WHERE id = $2', [nuevoSaldo, idUsuario]);

        // 4. Crear el pedido
        const queryPedido = 'INSERT INTO pedidos (usuario_id, total, estado) VALUES ($1, $2, $3) RETURNING id';
        const resultPedido = await client.query(queryPedido, [idUsuario, totalCompra, 'PENDIENTE']);
        const pedidoId = resultPedido.rows[0].id;

        // 5. Insertar detalle de productos
        const queryItem = 'INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES ($1, $2, $3, $4)';
        for (const item of items) {
            const prodId = item.productoId || item.producto_id;
            const precUnit = item.precioUnitario || item.precio_unitario;
            await client.query(queryItem, [pedidoId, prodId, item.cantidad, precUnit]);
        }

        await client.query('COMMIT');

        // Devolver respuesta exitosa con el nuevo saldo oficial
        res.json({ 
            success: true, 
            message: 'Pedido realizado con éxito', 
            pedidoId, 
            nuevoSaldo 
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en POST /api/pedidos:', err);
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
                CAST(p.total AS DOUBLE PRECISION) AS total, 
                p.estado 
            FROM pedidos p 
            LEFT JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.usuario_id = $1 
            ORDER BY p.id DESC
        `;
        const result = await pool.query(query, [usuarioId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error en GET /api/pedidos/usuario:', err);
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
                CAST(p.total AS DOUBLE PRECISION) AS total, 
                p.estado 
            FROM pedidos p 
            LEFT JOIN usuarios u ON p.usuario_id = u.id 
            ORDER BY p.id DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Error en GET /api/pedidos:', err);
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
                CAST(p.total AS DOUBLE PRECISION) AS total, 
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
            SELECT 
                p.nombre AS "productoNombre", 
                dp.cantidad, 
                CAST(dp.precio_unitario AS DOUBLE PRECISION) AS "precioUnitario" 
            FROM detalle_pedidos dp 
            JOIN productos p ON dp.producto_id = p.id 
            WHERE dp.pedido_id = $1
        `;
        const resultItems = await pool.query(queryItems, [id]);

        const pedido = resultPedido.rows[0];
        pedido.items = resultItems.rows;

        res.json(pedido);
    } catch (err) {
        console.error('Error en GET /api/pedidos/:id:', err);
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

app.get('/api/usuarios', async (req, res) => {
    try {
        const query = `
            SELECT 
                id, 
                nombre, 
                email, 
                rol, 
                CAST(saldo AS DOUBLE PRECISION) AS saldo,
                foto_perfil AS "fotoPerfil",
                TO_CHAR(fecha_registro, 'YYYY-MM-DD HH24:MI') AS "fechaRegistro"
            FROM usuarios 
            ORDER BY id ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Error en GET /api/usuarios:', err);
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT 
                id, 
                nombre, 
                email, 
                rol, 
                CAST(saldo AS DOUBLE PRECISION) AS saldo,
                foto_perfil AS "fotoPerfil"
            FROM usuarios 
            WHERE id = $1
        `;
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error en GET /api/usuarios/:id:', err);
        res.status(500).json({ message: err.message });
    }
});

app.put('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, fotoPerfil, foto_perfil } = req.body;
    const foto = fotoPerfil !== undefined ? fotoPerfil : foto_perfil;

    try {
        await pool.query(
            'UPDATE usuarios SET nombre = $1, email = $2, foto_perfil = $3 WHERE id = $4',
            [nombre, email, foto, id]
        );
        res.json({ success: true, message: 'Perfil actualizado' });
    } catch (err) {
        console.error('Error en PUT /api/usuarios/:id:', err);
        res.status(500).json({ success: false, message: 'Error al actualizar perfil: ' + err.message });
    }
});

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
        console.error('Error en PUT /api/usuarios/:id/password:', err);
        res.status(500).json({ success: false, message: 'Error al actualizar la contraseña' });
    }
});

app.put('/api/usuarios/admin/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, rol, fotoPerfil, foto_perfil, nuevaPassword, saldo } = req.body;
    const foto = fotoPerfil !== undefined ? fotoPerfil : foto_perfil;

    try {
        if (nuevaPassword && nuevaPassword.trim() !== '') {
            const hashedPassword = await bcrypt.hash(nuevaPassword, 10);
            await pool.query(
                'UPDATE usuarios SET nombre = $1, email = $2, rol = $3, foto_perfil = $4, password = $5, saldo = COALESCE($6, saldo) WHERE id = $7',
                [nombre, email, rol, foto, hashedPassword, saldo, id]
            );
        } else {
            await pool.query(
                'UPDATE usuarios SET nombre = $1, email = $2, rol = $3, foto_perfil = $4, saldo = COALESCE($5, saldo) WHERE id = $6',
                [nombre, email, rol, foto, saldo, id]
            );
        }
        res.json({ success: true, message: 'Usuario actualizado correctamente' });
    } catch (err) {
        console.error('Error en PUT /api/usuarios/admin/:id:', err);
        res.status(500).json({ success: false, message: 'Error al actualizar usuario: ' + err.message });
    }
});

app.delete('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
        res.json({ success: true, message: 'Usuario eliminado correctamente' });
    } catch (err) {
        console.error('Error en DELETE /api/usuarios/:id:', err);
        res.status(500).json({ success: false, message: 'Error al eliminar usuario. Verifique si tiene pedidos asociados.' });
    }
});

// ==========================================
// 5. GESTIÓN DE SALDO Y TRANSACCIONES (NUEVO)
// ==========================================

app.get('/api/usuarios/:id/saldo', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT id, nombre, email, rol, CAST(saldo AS DOUBLE PRECISION) AS saldo 
            FROM usuarios 
            WHERE id = $1
        `;
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error en GET /api/usuarios/:id/saldo:', err);
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/usuarios/:id/saldo/recargar', async (req, res) => {
    const { id } = req.params;
    const { monto } = req.body;
    try {
        const montoFloat = parseFloat(monto);
        if (isNaN(montoFloat) || montoFloat <= 0) {
            return res.status(400).json({ success: false, message: 'Monto inválido' });
        }

        const query = 'UPDATE usuarios SET saldo = COALESCE(saldo, 0) + $1 WHERE id = $2 RETURNING saldo';
        const result = await pool.query(query, [montoFloat, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }

        const nuevoSaldo = parseFloat(result.rows[0].saldo);

        res.json({
            success: true,
            message: 'Saldo recargado correctamente',
            nuevoSaldo
        });
    } catch (err) {
        console.error('Error en POST /api/usuarios/:id/saldo/recargar:', err);
        res.status(500).json({ success: false, message: 'Error al recargar saldo: ' + err.message });
    }
});

app.get('/api/usuarios/:id/transacciones', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT 
                p.id, 
                p.usuario_id AS "usuarioId", 
                CAST(p.total AS DOUBLE PRECISION) AS monto, 
                'COMPRA' AS tipo, 
                'Pedido #' || p.id AS descripcion, 
                TO_CHAR(p.fecha, 'YYYY-MM-DD HH24:MI') AS fecha
            FROM pedidos p 
            WHERE p.usuario_id = $1
            ORDER BY p.id DESC
        `;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error en GET /api/usuarios/:id/transacciones:', err);
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});