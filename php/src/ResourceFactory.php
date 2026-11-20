<?php

declare(strict_types=1);

namespace Instatus;

use OpenTelemetry\SDK\Common\Attribute\Attributes as OtelAttributes;
use OpenTelemetry\SDK\Resource\Detectors;
use OpenTelemetry\SDK\Resource\ResourceInfo;
use OpenTelemetry\SDK\Resource\ResourceInfoFactory;

final class ResourceFactory
{
    public const LANGUAGE = 'php';

    /**
     * Sentry's release and environment are OpenTelemetry resource attributes.
     *
     * @return array<string, string>
     */
    public static function attributes(Options $options, ?string $detectedServiceName = null): array
    {
        $attributes = [
            'service.name' => $options->serviceName ?? $detectedServiceName ?? self::LANGUAGE,
            'telemetry.sdk.name' => Version::SDK_NAME,
            'telemetry.sdk.version' => Version::VERSION,
            'telemetry.sdk.language' => self::LANGUAGE,
        ];
        if ($options->release !== null) {
            $attributes['service.version'] = $options->release;
        }
        if ($options->environment !== null) {
            $attributes['deployment.environment.name'] = $options->environment;
        }

        return $attributes;
    }

    public static function create(Options $options): ResourceInfo
    {
        $detected = ResourceInfoFactory::emptyResource()
            ->merge((new Detectors\Host())->getResource())
            ->merge((new Detectors\Process())->getResource())
            ->merge((new Detectors\Environment())->getResource());
        $serviceName = $detected->getAttributes()->get('service.name');

        return $detected->merge(ResourceInfo::create(OtelAttributes::create(
            self::attributes($options, is_string($serviceName) ? $serviceName : null)
        )));
    }
}
