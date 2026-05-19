# MiMenu · Menú Semanal

PWA para gestionar tus comidas y cenas de la semana, con lista de compra generada automáticamente.

## Características

- **Crear platos** con nombre, descripción, ingredientes (con cantidad) y tipo (comida / cena / ambos).
- **Generar una semana** aleatoria de 7 días con un plato para comer y otro para cenar.
- **Rerodar** un plato concreto si no te convence (botón ↻ que aparece al pasar por encima).
- **Lista de la compra** generada automáticamente, con ingredientes agregados de todos los platos de la semana. Marca/desmarca lo que ya tienes.
- **Tema oscuro / claro** con interruptor (preferencia guardada).
- **Todo offline**: tus datos viven en tu navegador (IndexedDB). Sin servidores, sin cuentas.
- **Instalable** como app nativa en móvil y escritorio (PWA).

## Cómo usar

1. Sirve los archivos desde un servidor HTTP (no `file://`, los Service Workers lo requieren). Las opciones más rápidas:

   ```bash
   # Python
   cd menu-app
   python3 -m http.server 8000
   
   # o Node
   npx serve .
   ```

2. Abre `http://localhost:8000` en tu navegador.

3. Para instalarla como app:
   - **Chrome/Edge (escritorio)**: icono de instalar en la barra de direcciones.
   - **Android**: menú → "Añadir a pantalla de inicio".
   - **iOS Safari**: compartir → "Añadir a pantalla de inicio".

## Estructura

```
menu-app/
├── index.html          # Estructura
├── styles.css          # Estilos (tema oscuro/claro)
├── app.js              # Lógica + IndexedDB
├── manifest.json       # Metadatos PWA
├── sw.js               # Service worker (offline)
└── icons/              # Iconos de la app
```

## Tecnologías

- HTML / CSS / JS puro (sin frameworks ni dependencias).
- IndexedDB para persistencia local.
- Service Worker para funcionamiento offline.
- Tipografía: Fraunces (display) + Inter Tight (UI) + JetBrains Mono (detalles).

## Tips

- En el formulario de plato, dentro del input de ingrediente: `Enter` salta a la cantidad y otro `Enter` lo añade.
- En **Compra**, el botón papelera arriba a la derecha desmarca todo de golpe (no borra la lista; se rehace cada vez que generas o cambias platos de la semana).
- La generación intenta no repetir el mismo plato dos días seguidos.
