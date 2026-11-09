<?php
declare(strict_types=1);
define('OC_CONSOLE', true);
require '/var/www/html/lib/base.php';
$result = [];
try {
    $manager = \OCP\Server::get(\OCP\App\IAppManager::class);
    $result['enabled'] = $manager->isEnabledForUser('vaultsync_bridge');
    $result['path'] = $manager->getAppPath('vaultsync_bridge');
    $result['routesFile'] = require $result['path'] . '/appinfo/routes.php';
    \OC_App::loadApp('vaultsync_bridge');
    foreach (['OCA\\VaultSyncBridge\\AppInfo\\Application', 'OCA\\VaultSyncBridge\\Controller\\ApiController'] as $class) {
        $result['classes'][$class] = class_exists($class) ? (new ReflectionClass($class))->getFileName() : false;
    }
    $router = \OCP\Server::get(\OCP\Route\IRouter::class);
    $router->loadRoutes('vaultsync_bridge');
    $result['routerClass'] = get_class($router);
    $reflection = new ReflectionObject($router);
    while ($reflection) {
        foreach ($reflection->getProperties() as $property) {
            if (!$property->isInitialized($router)) continue;
            $value = $property->getValue($router);
            $collections = $value instanceof \Symfony\Component\Routing\RouteCollection ? [$value] : (is_array($value) ? $value : []);
            foreach ($collections as $collection) {
                if (!$collection instanceof \Symfony\Component\Routing\RouteCollection) continue;
                foreach ($collection->all() as $name => $route) {
                    if (str_contains($name, 'vaultsync') || str_contains($route->getPath(), 'vaultsync')) {
                        $result['routes'][$name] = ['path' => $route->getPath(), 'methods' => $route->getMethods()];
                    }
                }
            }
        }
        $reflection = $reflection->getParentClass();
    }
} catch (Throwable $e) {
    $result['error'] = get_class($e) . ': ' . $e->getMessage();
    $result['stack'] = $e->getTraceAsString();
}
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
