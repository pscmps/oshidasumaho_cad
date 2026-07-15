import json
import traceback

import adsk.core
import adsk.fusion

try:
    from .oshida_model import (
        FACE_ORDER,
        get_document_dimensions,
        get_shape_profiles,
        normalize_document,
    )
except ImportError:
    from oshida_model import (
        FACE_ORDER,
        get_document_dimensions,
        get_shape_profiles,
        normalize_document,
    )


APP_NAME = 'Oshida Smartphone CAD Importer'
COMMAND_ID = 'oshidaSmartphoneCadImportJson'
COMMAND_NAME = 'Import Oshida CAD JSON'
COMMAND_DESCRIPTION = 'Import Oshida Smartphone CAD JSON as Fusion solid geometry.'
WORKSPACE_ID = 'FusionSolidEnvironment'
PANEL_ID = 'SolidScriptsAddinsPanel'
app = None
ui = None
handlers = []


def run(context):
    global app, ui
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface

        command_definition = ui.commandDefinitions.itemById(COMMAND_ID)
        if not command_definition:
            command_definition = ui.commandDefinitions.addButtonDefinition(
                COMMAND_ID,
                COMMAND_NAME,
                COMMAND_DESCRIPTION,
            )

        on_created = CommandCreatedHandler()
        command_definition.commandCreated.add(on_created)
        handlers.append(on_created)

        panel = ui.workspaces.itemById(WORKSPACE_ID).toolbarPanels.itemById(PANEL_ID)
        control = panel.controls.itemById(COMMAND_ID)
        if not control:
            control = panel.controls.addCommand(command_definition)
            control.isPromoted = True
    except Exception:
        if ui:
            ui.messageBox('Failed to start add-in:\n{}'.format(traceback.format_exc()))


def stop(context):
    try:
        command_definition = ui.commandDefinitions.itemById(COMMAND_ID) if ui else None
        if command_definition:
            control = ui.workspaces.itemById(WORKSPACE_ID).toolbarPanels.itemById(PANEL_ID).controls.itemById(COMMAND_ID)
            if control:
                control.deleteMe()
            command_definition.deleteMe()
    except Exception:
        if ui:
            ui.messageBox('Failed to stop add-in:\n{}'.format(traceback.format_exc()))


class CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            command = args.command
            command.isExecutedWhenPreEmpted = False
            inputs = command.commandInputs
            inputs.addTextBoxCommandInput(
                'description',
                'Import',
                'Select an Oshida Smartphone CAD JSON file. The importer builds one swept body for each face and intersects the three bodies.',
                3,
                True,
            )

            on_execute = CommandExecuteHandler()
            command.execute.add(on_execute)
            handlers.append(on_execute)
        except Exception:
            if ui:
                ui.messageBox('Command setup failed:\n{}'.format(traceback.format_exc()))


class CommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            path = pick_json_file()
            if not path:
                return
            with open(path, 'r', encoding='utf-8') as file:
                document_data = normalize_document(json.load(file))

            importer = FusionImporter(document_data)
            body = importer.import_part()
            if body:
                ui.messageBox('Imported: {}'.format(body.name))
        except Exception:
            if ui:
                ui.messageBox('Import failed:\n{}'.format(traceback.format_exc()))


def pick_json_file():
    dialog = ui.createFileDialog()
    dialog.title = 'Select Oshida Smartphone CAD JSON'
    dialog.filter = 'JSON files (*.json);;All files (*.*)'
    if dialog.showOpen() != adsk.core.DialogResults.DialogOK:
        return None
    return dialog.filename


def mm_to_cm(value):
    return float(value) / 10.0


def centered_mm(value, dimension):
    return float(value) - dimension['min'] - dimension['size'] / 2.0


def value_mm(amount):
    return adsk.core.ValueInput.createByString('{:.9f} mm'.format(float(amount)))


def clean_name(name):
    allowed = []
    for character in str(name):
        if character.isalnum() or character in ('-', '_', ' '):
            allowed.append(character)
        else:
            allowed.append('-')
    return ''.join(allowed).strip() or 'oshidasumaho-cad-part'


class FusionImporter:
    def __init__(self, document_data):
        self.document = document_data
        self.design = adsk.fusion.Design.cast(app.activeProduct)
        if not self.design:
            raise RuntimeError('Fusion Design workspaceで実行してください。')
        self.root = self.design.rootComponent
        self.dimensions = get_document_dimensions(document_data)
        self.created_planes = []
        self.created_sketches = []
        self.face_planes = {}

    def import_part(self):
        face_bodies = []
        for face in FACE_ORDER:
            body = self.build_face_body(face)
            if not body:
                raise ValueError('{}面に有効なadd図形がありません。'.format(face))
            body.name = '{}_sweep'.format(face)
            face_bodies.append(body)

        final_body = face_bodies[0]
        for tool_body in face_bodies[1:]:
            final_body = self.combine(final_body, [tool_body], adsk.fusion.FeatureOperations.IntersectFeatureOperation)

        final_body.name = clean_name(self.document.get('partName'))
        self.hide_construction()
        return final_body

    def build_face_body(self, face):
        body = None
        face_shapes = [
            shape
            for shape in self.document['shapes']
            if shape['face'] == face
        ]
        for shape in face_shapes:
            prism = self.create_shape_prism(face, shape)
            if shape.get('mode') == 'cut':
                if body:
                    body = self.combine(body, [prism], adsk.fusion.FeatureOperations.CutFeatureOperation)
                else:
                    prism.deleteMe()
                continue

            if body:
                body = self.combine(body, [prism], adsk.fusion.FeatureOperations.JoinFeatureOperation)
            else:
                body = prism
        return body

    def combine(self, target_body, tool_bodies, operation):
        tools = adsk.core.ObjectCollection.create()
        for body in tool_bodies:
            if body:
                tools.add(body)
        combine_input = self.root.features.combineFeatures.createInput(target_body, tools)
        combine_input.operation = operation
        combine_input.isKeepToolBodies = False
        result = self.root.features.combineFeatures.add(combine_input)
        if result.bodies.count < 1:
            return target_body
        return result.bodies.item(0)

    def create_shape_prism(self, face, shape):
        shape_id = shape.get('id', 'shape')
        profiles = get_shape_profiles(shape)
        body = self.create_profile_prism(face, profiles['outer'], '{}_outer'.format(shape_id))
        for hole_index, hole_profile in enumerate(profiles['holes']):
            hole_body = self.create_profile_prism(
                face,
                hole_profile,
                '{}_hole_{}'.format(shape_id, hole_index + 1),
            )
            body = self.combine(body, [hole_body], adsk.fusion.FeatureOperations.CutFeatureOperation)
        body.name = '{}_{}_{}'.format(face, shape.get('mode', 'add'), shape_id)
        return body

    def create_profile_prism(self, face, profile_data, label):
        sketch = self.create_face_sketch(face, label)
        self.draw_profile(sketch, face, profile_data)
        if sketch.profiles.count < 1:
            raise ValueError('図形からプロファイルを作成できません: {}'.format(label))
        profile = sketch.profiles.item(0)
        extrudes = self.root.features.extrudeFeatures
        extrude_input = extrudes.createInput(profile, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        distance, direction = self.get_extrude_distance_and_direction(face)
        extent = adsk.fusion.DistanceExtentDefinition.create(value_mm(distance))
        extrude_input.setOneSideExtent(extent, direction)
        feature = extrudes.add(extrude_input)
        if feature.bodies.count < 1:
            raise ValueError('押し出しボディを作成できません。')
        return feature.bodies.item(0)

    def create_face_sketch(self, face, label):
        plane = self.create_face_plane(face)
        sketch = self.root.sketches.add(plane)
        sketch.name = 'OSC_{}_{}'.format(face, label)
        self.created_sketches.append(sketch)
        return sketch

    def create_face_plane(self, face):
        if face in self.face_planes:
            return self.face_planes[face]
        planes = self.root.constructionPlanes
        plane_input = planes.createInput()
        if face == 'top':
            base_plane = self.root.xYConstructionPlane
            offset = -self.dimensions['height']['size'] / 2.0
        elif face == 'front':
            base_plane = self.root.xZConstructionPlane
            offset = self.dimensions['depth']['size'] / 2.0
        else:
            base_plane = self.root.yZConstructionPlane
            offset = -self.dimensions['width']['size'] / 2.0
        plane_input.setByOffset(base_plane, value_mm(offset))
        plane = planes.add(plane_input)
        plane.name = 'OSC_{}_start'.format(face)
        self.created_planes.append(plane)
        self.face_planes[face] = plane
        return plane

    def get_extrude_distance_and_direction(self, face):
        if face == 'top':
            return self.dimensions['height']['size'], adsk.fusion.ExtentDirections.PositiveExtentDirection
        if face == 'front':
            return self.dimensions['depth']['size'], adsk.fusion.ExtentDirections.NegativeExtentDirection
        return self.dimensions['width']['size'], adsk.fusion.ExtentDirections.PositiveExtentDirection

    def draw_profile(self, sketch, face, profile_data):
        if profile_data['kind'] == 'circle':
            center = self.get_sketch_point(face, *profile_data['center'])
            sketch.sketchCurves.sketchCircles.addByCenterRadius(
                center,
                mm_to_cm(profile_data['radius']),
            )
            return
        points = profile_data['points']
        if len(points) < 3:
            raise ValueError('閉じた輪郭には3点以上必要です。')
        lines = sketch.sketchCurves.sketchLines
        sketch_points = [self.get_sketch_point(face, *point) for point in points]
        for index, start in enumerate(sketch_points):
            lines.addByTwoPoints(start, sketch_points[(index + 1) % len(sketch_points)])

    def get_sketch_point(self, face, first, second):
        if face == 'top':
            u = centered_mm(first, self.dimensions['width'])
            v = centered_mm(second, self.dimensions['depth'])
        elif face == 'front':
            u = centered_mm(first, self.dimensions['width'])
            v = centered_mm(second, self.dimensions['height'])
        else:
            u = centered_mm(first, self.dimensions['depth'])
            v = centered_mm(second, self.dimensions['height'])
        return adsk.core.Point3D.create(mm_to_cm(u), mm_to_cm(v), 0)

    def hide_construction(self):
        for sketch in self.created_sketches:
            sketch.isVisible = False
        for plane in self.created_planes:
            plane.isLightBulbOn = False


def _test_dimensions(document_data):
    return get_document_dimensions(normalize_document(document_data))
