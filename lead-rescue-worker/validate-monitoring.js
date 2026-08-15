#!/usr/bin/env node
// validate-monitoring.js
// Script de validación pre-deployment del sistema de monitoreo

const fs = require('fs');
const path = require('path');

console.log('🔍 Validando Sistema de Monitoreo OTIF Sentinel...\n');

let errors = 0;
let warnings = 0;
let checks = 0;

function check(condition, message, isWarning = false) {
  checks++;
  if (condition) {
    console.log(`✅ ${message}`);
    return true;
  } else {
    if (isWarning) {
      console.log(`⚠️  ${message}`);
      warnings++;
    } else {
      console.log(`❌ ${message}`);
      errors++;
    }
    return false;
  }
}

// 1. Verificar archivos de monitoreo existen
console.log('📁 Verificando archivos del sistema de monitoreo...\n');

const monitoringFiles = [
  'src/monitoring/config.js',
  'src/monitoring/index.js',
  'src/monitoring/logger.js',
  'src/monitoring/health.js',
  'src/monitoring/errors.js',
  'src/monitoring/metrics.js',
  'src/monitoring/middleware.js',
  'src/monitoring/queue-middleware.js',
  'src/monitoring/rate-limiter.js',
  'src/monitoring/alerts.js',
  'src/monitoring/auth.js',
  'src/monitoring/dashboard.js',
];

monitoringFiles.forEach(file => {
  const exists = fs.existsSync(path.join(__dirname, file));
  check(exists, `Archivo ${file} existe`);
});

// 2. Verificar migraciones
console.log('\n📊 Verificando archivos de migración...\n');

const migrationFiles = [
  'migrations/001_monitoring_schema.sql',
  'migrations/001_rollback.sql',
];

migrationFiles.forEach(file => {
  const exists = fs.existsSync(path.join(__dirname, file));
  check(exists, `Migración ${file} existe`);
});

// 3. Verificar archivos de test
console.log('\n🧪 Verificando archivos de test...\n');

const testFiles = [
  'src/monitoring/errors.test.js',
  'src/monitoring/health.test.js',
  'src/monitoring/middleware.test.js',
];

testFiles.forEach(file => {
  const exists = fs.existsSync(path.join(__dirname, file));
  check(exists, `Test ${file} existe`, true); // Warning, no error
});

// 4. Verificar configuración en wrangler.jsonc
console.log('\n⚙️  Verificando configuración en wrangler.jsonc...\n');

try {
  const wranglerPath = path.join(__dirname, 'wrangler.jsonc');
  const wranglerContent = fs.readFileSync(wranglerPath, 'utf8');
  
  // Remove comments from JSONC
  const jsonContent = wranglerContent
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove /* */ comments
    .replace(/\/\/.*/g, ''); // Remove // comments
  
  const config = JSON.parse(jsonContent);
  
  check(config.vars.MONITORING_ENABLED === 'true', 'MONITORING_ENABLED está habilitado');
  check(config.vars.MONITORING_ERROR_TRACKING === 'true', 'MONITORING_ERROR_TRACKING está habilitado');
  check(config.vars.MONITORING_METRICS === 'true', 'MONITORING_METRICS está habilitado');
  check(config.vars.MONITORING_ALERTING === 'true', 'MONITORING_ALERTING está habilitado');
  check(config.vars.MONITORING_SAMPLE_RATE === '0.1', 'MONITORING_SAMPLE_RATE configurado (0.1)');
  check(config.vars.MONITORING_USERNAME, 'MONITORING_USERNAME configurado');
  check(
    !Object.hasOwn(config.vars, 'MONITORING_PASSWORD'),
    'MONITORING_PASSWORD no está expuesto en vars; debe configurarse como Secret',
  );
  
  check(config.triggers && config.triggers.crons, 'Cron jobs configurados');
  check(config.queues && config.queues.producers, 'Queues configuradas');
  check(config.hyperdrive, 'Hyperdrive (PostgreSQL) configurado');
  
} catch (error) {
  check(false, `Error leyendo wrangler.jsonc: ${error.message}`);
}

// 5. Verificar sintaxis de archivos principales
console.log('\n🔧 Verificando sintaxis de JavaScript...\n');

const { execSync } = require('child_process');

const filesToCheck = [
  'src/index.js',
  'src/queues.js',
  'src/monitoring/config.js',
  'src/monitoring/dashboard.js',
  'src/monitoring/auth.js',
];

filesToCheck.forEach(file => {
  try {
    execSync(`node --check ${file}`, { cwd: __dirname, stdio: 'pipe' });
    check(true, `Sintaxis correcta en ${file}`);
  } catch (error) {
    check(false, `Error de sintaxis en ${file}`);
  }
});

// 6. Verificar imports en index.js
console.log('\n🔗 Verificando integraciones en src/index.js...\n');

try {
  const indexContent = fs.readFileSync(path.join(__dirname, 'src/index.js'), 'utf8');
  
  check(indexContent.includes("from './monitoring/health.js'"), 'Import de health.js presente');
  check(indexContent.includes("from './monitoring/alerts.js'"), 'Import de alerts.js presente');
  check(indexContent.includes("from './monitoring/dashboard.js'"), 'Import de dashboard.js presente');
  check(indexContent.includes('handleHealthCheck'), 'Uso de handleHealthCheck presente');
  check(indexContent.includes('evaluateAlerts'), 'Uso de evaluateAlerts en cron presente');
  check(indexContent.includes('renderDashboard'), 'Uso de renderDashboard presente');
  check(indexContent.includes('getDashboardData'), 'Uso de getDashboardData presente');
  check(indexContent.includes('/health'), 'Ruta /health presente');
  check(indexContent.includes('/dashboard/monitoring'), 'Ruta /dashboard/monitoring presente');
  check(indexContent.includes('/api/dashboard/data'), 'Ruta /api/dashboard/data presente');
  
} catch (error) {
  check(false, `Error leyendo src/index.js: ${error.message}`);
}

// 7. Verificar imports en queues.js
console.log('\n🔗 Verificando integraciones en src/queues.js...\n');

try {
  const queuesContent = fs.readFileSync(path.join(__dirname, 'src/queues.js'), 'utf8');
  
  check(queuesContent.includes("from './monitoring/queue-middleware.js'"), 'Import de queue-middleware.js presente');
  check(queuesContent.includes('withQueueMonitoring'), 'Uso de withQueueMonitoring presente');
  check(queuesContent.includes('processIngestionQueue'), 'processIngestionQueue definido');
  check(queuesContent.includes('processEnrichmentQueue'), 'processEnrichmentQueue definido');
  check(queuesContent.includes('processDeliveryQueue'), 'processDeliveryQueue definido');
  
} catch (error) {
  check(false, `Error leyendo src/queues.js: ${error.message}`);
}

// 8. Verificar documentación
console.log('\n📚 Verificando documentación...\n');

const docsFiles = [
  'DEPLOYMENT_GUIDE.md',
  'MONITORING_SYSTEM_SUMMARY.md',
];

docsFiles.forEach(file => {
  const exists = fs.existsSync(path.join(__dirname, file));
  check(exists, `Documentación ${file} existe`);
});

// 9. Verificar estructura de directorios
console.log('\n📂 Verificando estructura de directorios...\n');

const dirs = [
  'src/monitoring',
  'migrations',
];

dirs.forEach(dir => {
  const exists = fs.existsSync(path.join(__dirname, dir));
  check(exists, `Directorio ${dir} existe`);
});

// Resumen final
console.log('\n' + '='.repeat(60));
console.log('📊 RESUMEN DE VALIDACIÓN');
console.log('='.repeat(60));
console.log(`Total de verificaciones: ${checks}`);
console.log(`✅ Exitosas: ${checks - errors - warnings}`);
console.log(`⚠️  Advertencias: ${warnings}`);
console.log(`❌ Errores: ${errors}`);
console.log('='.repeat(60));

if (errors === 0 && warnings === 0) {
  console.log('\n🎉 ¡VALIDACIÓN EXITOSA! El sistema está listo para deployment.');
  console.log('\nPróximos pasos:');
  console.log('  1. Desactiva VPN/proxy corporativo si está activo');
  console.log('  2. Ejecuta: npx wrangler deploy');
  console.log('  3. Ejecuta las migraciones de base de datos');
  console.log('  4. Verifica /health endpoint');
  console.log('  5. Accede al dashboard en /dashboard/monitoring');
  process.exit(0);
} else if (errors === 0 && warnings > 0) {
  console.log('\n⚠️  VALIDACIÓN COMPLETADA CON ADVERTENCIAS');
  console.log('El sistema puede desplegarse, pero revisa las advertencias arriba.');
  process.exit(0);
} else {
  console.log('\n❌ VALIDACIÓN FALLÓ');
  console.log(`Hay ${errors} error(es) que deben corregirse antes del deployment.`);
  process.exit(1);
}
