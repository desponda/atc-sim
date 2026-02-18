// vice-extract: Extracts video map data from Vice's binary gob+zstd format
// and converts it to atc-sim's JSON video map format.
//
// Vice (github.com/mmp/vice) stores video maps as Go gob-encoded structs
// compressed with zstd. This tool decodes those files and outputs JSON
// compatible with our VideoMap[] TypeScript type.
//
// Usage:
//   go run . -videomaps /path/to/ZDC-videomaps.gob.zst \
//            -manifest /path/to/ZDC-manifest.gob \
//            -filter "JRV North,JRV CSIDE,PCT MVA,..." \
//            -clip-lat 37.505 -clip-lon -77.320 -clip-radius 80 \
//            -out /path/to/videomaps.json

package main

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"strings"

	"github.com/klauspost/compress/zstd"
)

// ──────────────────────────────────────────────────────────────────────
// Vice-compatible types for gob decoding
// These must match Vice's struct field names exactly for gob to decode.
// Source: github.com/mmp/vice/sim/stars.go, math/latlong.go
// ──────────────────────────────────────────────────────────────────────

// Point2LL matches Vice's math.Point2LL: [longitude, latitude] as float32
type Point2LL [2]float32

// VideoMap matches Vice's sim.VideoMap struct
type VideoMap struct {
	Label       string
	Group       int
	Name        string
	Id          int
	Category    int
	Restriction struct {
		Id        int
		Text      [2]string
		TextBlink bool
		HideText  bool
	}
	Color int
	Lines [][]Point2LL
}

// VideoMapLibrary matches Vice's sim.VideoMapLibrary
// Note: ERAMMapGroups is intentionally omitted — gob ignores missing fields
type VideoMapLibrary struct {
	Maps []VideoMap
}

// ──────────────────────────────────────────────────────────────────────
// Output JSON types matching atc-sim's VideoMap TypeScript interface
// ──────────────────────────────────────────────────────────────────────

type Position struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type VideoMapFeature struct {
	Type   string     `json:"type"`
	Points []Position `json:"points,omitempty"`
}

type OutputVideoMap struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	ShortName      string            `json:"shortName"`
	DefaultVisible bool              `json:"defaultVisible"`
	ViceId         int               `json:"viceId"`
	Group          int               `json:"group"`
	Category       int               `json:"category"`
	Color          int               `json:"color"`
	Features       []VideoMapFeature `json:"features"`
}

// ──────────────────────────────────────────────────────────────────────
// Geographic utilities
// ──────────────────────────────────────────────────────────────────────

const nmPerDegLat = 60.0 // 1 degree latitude ≈ 60 nm

func nmPerDegLon(lat float64) float64 {
	return 60.0 * math.Cos(lat*math.Pi/180.0)
}

// distanceNM returns approximate distance in nautical miles between two points
func distanceNM(lat1, lon1, lat2, lon2 float64) float64 {
	dlat := (lat2 - lat1) * nmPerDegLat
	dlon := (lon2 - lon1) * nmPerDegLon((lat1+lat2)/2)
	return math.Sqrt(dlat*dlat + dlon*dlon)
}

// roundCoord rounds a coordinate to n decimal places
// 5 decimal places ≈ 1.1m accuracy (more than sufficient for radar display)
func roundCoord(v float64, decimals int) float64 {
	pow := math.Pow(10, float64(decimals))
	return math.Round(v*pow) / pow
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

func main() {
	manifestPath := flag.String("manifest", "", "Path to manifest .gob file")
	videomapPath := flag.String("videomaps", "", "Path to videomaps .gob.zst file")
	filterNames := flag.String("filter", "", "Comma-separated map names to extract (empty = all)")
	outPath := flag.String("out", "videomaps.json", "Output JSON file path")
	clipLat := flag.Float64("clip-lat", 0, "Center latitude for geographic clipping (0 = no clip)")
	clipLon := flag.Float64("clip-lon", 0, "Center longitude for geographic clipping")
	clipRadius := flag.Float64("clip-radius", 80, "Clipping radius in nautical miles")
	precision := flag.Int("precision", 5, "Coordinate decimal places (5 ≈ 1m accuracy)")
	compact := flag.Bool("compact", false, "Compact JSON output (no indentation)")
	flag.Parse()

	if *videomapPath == "" {
		fmt.Fprintf(os.Stderr, "Usage: vice-extract -videomaps <path> [options]\n\n")
		fmt.Fprintf(os.Stderr, "Options:\n")
		flag.PrintDefaults()
		os.Exit(1)
	}

	doClip := *clipLat != 0

	// Register []string for gob interface decoding
	// (manifest uses map[string]any which may contain []string values)
	gob.Register([]string{})

	// 1. Load and display manifest if provided
	if *manifestPath != "" {
		names, err := loadManifest(*manifestPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: Failed to load manifest: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "Manifest contains %d map names\n\n", len(names))
		}
	}

	// 2. Load video map library
	fmt.Fprintf(os.Stderr, "Loading video maps from %s...\n", *videomapPath)
	vmLib, err := loadVideoMaps(*videomapPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading video maps: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "Loaded %d total video maps from file\n", len(vmLib.Maps))

	if doClip {
		fmt.Fprintf(os.Stderr, "Clipping to %.1f nm radius around (%.3f, %.3f)\n", *clipRadius, *clipLat, *clipLon)
	}
	fmt.Fprintf(os.Stderr, "Coordinate precision: %d decimal places\n\n", *precision)

	// 3. Build filter set from comma-separated names
	filterSet := make(map[string]bool)
	if *filterNames != "" {
		for _, name := range strings.Split(*filterNames, ",") {
			name = strings.TrimSpace(name)
			if name != "" {
				filterSet[name] = true
			}
		}
		fmt.Fprintf(os.Stderr, "Filtering to %d requested maps\n\n", len(filterSet))
	}

	// 4. Convert matching maps to our JSON format
	var outputMaps []OutputVideoMap
	defaultVisibleCount := 0
	totalPointsBefore := 0
	totalPointsAfter := 0
	totalFeaturesBefore := 0
	totalFeaturesAfter := 0

	for _, vm := range vmLib.Maps {
		// Skip if not in filter set
		if len(filterSet) > 0 && !filterSet[vm.Name] {
			continue
		}

		// Count before clipping
		for _, strip := range vm.Lines {
			totalFeaturesBefore++
			totalPointsBefore += len(strip)
		}

		// First 6 non-empty maps default to visible
		isDefaultVisible := defaultVisibleCount < 6 && len(vm.Lines) > 0
		outMap := convertMap(vm, isDefaultVisible, doClip, *clipLat, *clipLon, *clipRadius, *precision)

		// Count after conversion
		for _, f := range outMap.Features {
			totalFeaturesAfter++
			totalPointsAfter += len(f.Points)
		}

		outputMaps = append(outputMaps, outMap)
		if len(vm.Lines) > 0 {
			defaultVisibleCount++
		}

		// Statistics
		fmt.Fprintf(os.Stderr, "  [%3d] %-25s  %5d features, %7d points",
			vm.Id, vm.Name, len(outMap.Features), countPoints(outMap))
		if doClip {
			origPts := 0
			for _, s := range vm.Lines {
				origPts += len(s)
			}
			if origPts > 0 {
				pct := float64(countPoints(outMap)) / float64(origPts) * 100
				fmt.Fprintf(os.Stderr, "  (%.0f%% of %d)", pct, origPts)
			}
		}
		fmt.Fprintln(os.Stderr)
	}

	// 5. Report missing maps
	if len(filterSet) > 0 {
		foundSet := make(map[string]bool)
		for _, m := range outputMaps {
			foundSet[m.Name] = true
		}
		for name := range filterSet {
			if !foundSet[name] {
				fmt.Fprintf(os.Stderr, "  WARNING: Requested map '%s' NOT FOUND in video map file\n", name)
			}
		}
	}

	fmt.Fprintf(os.Stderr, "\nSummary: %d maps, %d features (%d before), %d points (%d before)\n",
		len(outputMaps), totalFeaturesAfter, totalFeaturesBefore, totalPointsAfter, totalPointsBefore)

	// 6. Write output JSON
	var data []byte
	if *compact {
		data, err = json.Marshal(outputMaps)
	} else {
		data, err = json.MarshalIndent(outputMaps, "", "  ")
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling JSON: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*outPath, data, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing output: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "Wrote %s (%.2f MB)\n", *outPath, float64(len(data))/1024/1024)
}

func countPoints(m OutputVideoMap) int {
	n := 0
	for _, f := range m.Features {
		n += len(f.Points)
	}
	return n
}

// ──────────────────────────────────────────────────────────────────────
// Loading Vice binary formats
// ──────────────────────────────────────────────────────────────────────

func loadManifest(path string) (map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var names map[string]any
	if err := gob.NewDecoder(f).Decode(&names); err != nil {
		return nil, fmt.Errorf("gob decode manifest: %w", err)
	}
	return names, nil
}

func loadVideoMaps(path string) (*VideoMapLibrary, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var r io.Reader
	br := bytes.NewReader(data)

	// Check for zstd magic bytes: 0x28 0xB5 0x2F 0xFD
	if len(data) > 4 && data[0] == 0x28 && data[1] == 0xb5 && data[2] == 0x2f && data[3] == 0xfd {
		fmt.Fprintf(os.Stderr, "Detected zstd compression, decompressing...\n")
		zr, err := zstd.NewReader(br, zstd.WithDecoderConcurrency(0))
		if err != nil {
			return nil, fmt.Errorf("zstd init: %w", err)
		}
		defer zr.Close()
		r = zr
	} else {
		fmt.Fprintf(os.Stderr, "No zstd compression detected, reading raw gob\n")
		r = br
	}

	// Try decoding as VideoMapLibrary first (current Vice format)
	var vmf VideoMapLibrary
	if err := gob.NewDecoder(r).Decode(&vmf); err != nil {
		fmt.Fprintf(os.Stderr, "VideoMapLibrary decode failed (%v), trying []VideoMap fallback...\n", err)

		// Reset reader for retry
		br = bytes.NewReader(data)
		if len(data) > 4 && data[0] == 0x28 && data[1] == 0xb5 && data[2] == 0x2f && data[3] == 0xfd {
			zr, _ := zstd.NewReader(br, zstd.WithDecoderConcurrency(0))
			defer zr.Close()
			r = zr
		} else {
			r = br
		}

		// Try decoding as just []VideoMap (old format)
		if err2 := gob.NewDecoder(r).Decode(&vmf.Maps); err2 != nil {
			return nil, fmt.Errorf("gob decode failed (both formats): library=%v, slice=%v", err, err2)
		}
	}

	return &vmf, nil
}

// ──────────────────────────────────────────────────────────────────────
// Conversion to our JSON format
// ──────────────────────────────────────────────────────────────────────

func convertMap(vm VideoMap, defaultVisible bool, doClip bool, clipLat, clipLon, clipRadius float64, precision int) OutputVideoMap {
	id := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(vm.Name, " ", "-"), "/", "-"))
	shortName := generateShortName(vm.Name)

	features := make([]VideoMapFeature, 0, len(vm.Lines))
	for _, strip := range vm.Lines {
		if len(strip) < 2 {
			continue // skip degenerate strips
		}

		// Geographic clipping: skip entire line strip if ANY point is outside radius
		if doClip {
			outside := false
			for _, p := range strip {
				lat, lon := float64(p[1]), float64(p[0])
				if distanceNM(clipLat, clipLon, lat, lon) > clipRadius {
					outside = true
					break
				}
			}
			if outside {
				continue
			}
		}

		points := make([]Position, len(strip))
		for j, p := range strip {
			points[j] = Position{
				Lat: roundCoord(float64(p[1]), precision), // Point2LL[1] = latitude
				Lon: roundCoord(float64(p[0]), precision), // Point2LL[0] = longitude
			}
		}
		features = append(features, VideoMapFeature{
			Type:   "line",
			Points: points,
		})
	}

	return OutputVideoMap{
		ID:             id,
		Name:           vm.Name,
		ShortName:      shortName,
		DefaultVisible: defaultVisible,
		ViceId:         vm.Id,
		Group:          vm.Group,
		Category:       vm.Category,
		Color:          vm.Color,
		Features:       features,
	}
}

// generateShortName produces a short label (max 8 chars) for DCB buttons
func generateShortName(name string) string {
	// Well-known PCT/JRV map short names
	known := map[string]string{
		"PCT Coastlines":     "COAST",
		"PCT Roads":          "ROADS",
		"PCT MVA":            "MVA",
		"PCT Airport":        "APTS",
		"PCT ClassB":         "CLSB",
		"PCT ClassD":         "CLSD",
		"PCT Zones":          "ZONES",
		"PCT MEGA Combined":  "MEGA",
		"PCT TAirway":        "T-AWY",
		"PCT JAirway":        "J-AWY",
		"PCT QAirway":        "Q-AWY",
		"PCT VAirway":        "V-AWY",
		"PCT Helo Route":     "HELO",
		"PCT SFRA":           "SFRA",
		"JRV North":          "NORTH",
		"JRV South":          "SOUTH",
		"JRV CSIDE":          "CSIDE",
		"JRV STAR":           "STAR",
		"JRV WIGOL STAR":     "WIGOL",
		"JRV Sat Approaches": "SATAPP",
		"JRV Fixes":          "FIXES",
		"JRV RAREA":          "RAREA",
		"RIC IAP H02-Y":      "02-Y",
		"RIC IAP H20-Y":      "20-Y",
		"RIC IAP H16-Y":      "16-Y",
		"RIC IAP H34-Y":      "34-Y",
	}
	if short, ok := known[name]; ok {
		return short
	}

	// Fallback: strip common prefixes and truncate
	s := name
	for _, prefix := range []string{"PCT ", "JRV ", "RIC "} {
		s = strings.TrimPrefix(s, prefix)
	}
	if len(s) > 8 {
		s = s[:8]
	}
	return strings.TrimSpace(s)
}
