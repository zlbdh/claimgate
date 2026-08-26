import type { DemoRole } from "@/shared/demo-identity";
import type { RateLimitAction } from "@/server/security/rate-limit";
import {
  INSTANCE_RATE_LIMIT_POLICIES,
  type RateLimitPolicy,
} from "@/server/security/rate-limit-policy";
import { DomainError } from "@/shared/domain-error";

type AuthenticatedRouteDefinition = Readonly<{
  method: "POST";
  path: string;
  action: RateLimitAction;
  allowedRoles: readonly DemoRole[];
  requiresOneTime: boolean;
  ratePolicy: RateLimitPolicy;
}>;

const publicDemoRoles = Object.freeze(["CLAIMANT", "STAFF"] as const);

export const AUTHENTICATED_ROUTE_REGISTRY = Object.freeze({
  "api.demo.switch-role": Object.freeze({
    method: "POST",
    path: "/api/demo/switch-role",
    action: "role_switch",
    allowedRoles: publicDemoRoles,
    requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.role_switch,
  }),
} satisfies Record<string, AuthenticatedRouteDefinition>);

export type AuthenticatedRouteKey = keyof typeof AUTHENTICATED_ROUTE_REGISTRY;

export function getAuthenticatedRoute(
  routeKey: AuthenticatedRouteKey,
): AuthenticatedRouteDefinition {
  if (!Object.prototype.hasOwnProperty.call(AUTHENTICATED_ROUTE_REGISTRY, routeKey)) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  return AUTHENTICATED_ROUTE_REGISTRY[routeKey];
}
