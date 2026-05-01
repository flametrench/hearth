<?php

use App\Http\Controllers\InstallController;
use Illuminate\Support\Facades\Route;

Route::get('/healthz', fn () => ['status' => 'ok']);

Route::prefix('app')->group(function () {
    Route::get('/install/status', [InstallController::class, 'status']);
    Route::post('/install', [InstallController::class, 'install']);
});
