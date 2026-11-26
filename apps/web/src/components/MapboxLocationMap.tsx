"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapboxMap, Marker, MarkerOptions } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

export type MapCoordinate = { readonly lat: number; readonly lng: number };
export type MapArea = MapCoordinate & { readonly radiusMeters: number };

type Props = {
  readonly point: MapCoordinate | null;
  readonly area: MapArea | null;
  readonly editable?: boolean;
  readonly onChoose?: (coordinate: MapCoordinate) => void;
  readonly label: string;
  readonly locale: "en" | "ja";
};

const token = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ?? "";
const FALLBACK = { lat: 35.3192, lng: 139.5503 };
const AREA_SOURCE = "niho-public-area";

/** Mapbox is imported only as the map nears the viewport. The inputs passed here must already be public-safe. */
export function MapboxLocationMap({ point, area, editable = false, onChoose, label, locale }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<MapboxMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const current = useRef({ point, area, onChoose });
  const [nearViewport, setNearViewport] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    current.current = { point, area, onChoose };
  }, [point, area, onChoose]);

  useEffect(() => {
    const node = wrapper.current;
    if (!node || !token) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport || !token || !mapElement.current) return;
    let active = true;
    let instance: MapboxMap | null = null;
    void import("mapbox-gl").then(({ default: mapboxgl }) => {
      if (!active || !mapElement.current) return;
      mapboxgl.accessToken = token;
      const initial = current.current.point ?? current.current.area ?? FALLBACK;
      instance = new mapboxgl.Map({
        container: mapElement.current,
        style: "mapbox://styles/mapbox/streets-v12",
        center: [initial.lng, initial.lat],
        zoom: current.current.point ? 14 : current.current.area ? 12 : 11,
        language: locale === "ja" ? "ja" : "en",
        cooperativeGestures: true,
        scrollZoom: false,
        attributionControl: true,
        transformRequest: (url) => ({ url, ...(url.includes("mapbox.com") ? { referrerPolicy: "origin" } : {}) }),
      });
      map.current = instance;
      instance.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
      instance.on("load", () => {
        if (!active || !instance) return;
        instance.addSource(AREA_SOURCE, { type: "geojson", data: areaFeature(current.current.area) });
        instance.addLayer({ id: "niho-public-area-fill", type: "fill", source: AREA_SOURCE, paint: { "fill-color": "#6e8e70", "fill-opacity": 0.2 } });
        instance.addLayer({ id: "niho-public-area-line", type: "line", source: AREA_SOURCE, paint: { "line-color": "#3f6650", "line-width": 2 } });
        syncMarker(instance, marker, mapboxgl.Marker, current.current.point);
        setReady(true);
      });
      if (editable) instance.on("click", (event) => current.current.onChoose?.({ lat: event.lngLat.lat, lng: event.lngLat.lng }));
      instance.on("error", () => { if (active) setFailed(true); });
    }).catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      marker.current?.remove();
      marker.current = null;
      instance?.remove();
      if (map.current === instance) map.current = null;
    };
  }, [editable, locale, nearViewport]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource(AREA_SOURCE) as GeoJSONSource | undefined;
    source?.setData(areaFeature(area));
    void import("mapbox-gl").then(({ default: mapboxgl }) => { if (map.current === instance) syncMarker(instance, marker, mapboxgl.Marker, point); });
    const focus = point ?? area;
    if (focus) instance.easeTo({ center: [focus.lng, focus.lat], duration: 250 });
  }, [area, point, ready]);

  if (!editable && !token) return null;

  return <div ref={wrapper} className="relative overflow-hidden rounded-2xl border border-line bg-sand" aria-label={label}>
    <div ref={mapElement} className="aspect-[3/2] w-full lg:aspect-auto lg:h-[300px]" role="img" aria-label={label} />
    {!token || failed ? <p className="absolute inset-x-3 bottom-3 rounded-lg bg-white/95 p-2 text-xs text-ink-soft">{label}</p> : !ready ? <p className="sr-only" role="status">Loading map</p> : null}
  </div>;
}

function syncMarker(map: MapboxMap, marker: { current: Marker | null }, MarkerClass: new (options?: MarkerOptions) => Marker, point: MapCoordinate | null) {
  if (!point) {
    marker.current?.remove();
    marker.current = null;
    return;
  }
  marker.current?.setLngLat([point.lng, point.lat]);
  if (!marker.current) marker.current = new MarkerClass({ color: "#3f6650" }).setLngLat([point.lng, point.lat]).addTo(map);
}

function areaFeature(area: MapArea | null) {
  const ring: [number, number][] = [];
  if (area) {
    const earthRadius = 6_371_000;
    const lat = area.lat * Math.PI / 180;
    const lng = area.lng * Math.PI / 180;
    const angularRadius = area.radiusMeters / earthRadius;
    for (let bearing = 0; bearing <= 360; bearing += 5) {
      const direction = bearing * Math.PI / 180;
      const nextLat = Math.asin(Math.sin(lat) * Math.cos(angularRadius) + Math.cos(lat) * Math.sin(angularRadius) * Math.cos(direction));
      const nextLng = lng + Math.atan2(Math.sin(direction) * Math.sin(angularRadius) * Math.cos(lat), Math.cos(angularRadius) - Math.sin(lat) * Math.sin(nextLat));
      ring.push([nextLng * 180 / Math.PI, nextLat * 180 / Math.PI]);
    }
  }
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: ring.length ? [ring] : [] } };
}
