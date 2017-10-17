import { animate, style, transition, trigger } from '@angular/animations';
import {
    Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges
} from '@angular/core';
import { FormArray, FormBuilder, FormGroup } from '@angular/forms';

import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import { Observable } from 'rxjs/Observable';
import { Subscription } from 'rxjs/Subscription';

import * as _ from 'lodash';

import { TableMeta, TableName } from '../common/api';
import { TableService } from '../core/table.service';
import { FormControlSpec } from './form-control-spec.interface';
import { FormSpecGeneratorService } from './form-spec-generator.service';

interface Binding {
    controlName: string;
    valueChanges: Observable<any>;
    subscriptions: Subscription[];
    lastValue: any;
}

/**
 * A "partial" form handles data entry for exactly one table. Each instance
 * handles zero or more entries to that table. Upon receiving `rootGroup`, a
 * FormArray is added to that group whose key is the raw name of the table.
 *
 * If this form is for a part table, it is possible that one or more of the
 * controls in each FormGroup in the FormArray can be "bound" to another
 * control. When this happens, the control will be disabled and will
 * automatically update to the value of the control in the master table that
 * it's bound to.
 *
 * @see FormSpecGeneratorService.bindingConstraints
 */
@Component({
    selector: 'partial-form',
    templateUrl: 'partial-form.component.html',
    styleUrls: ['partial-form.component.scss'],
    animations: [
        trigger('fade', [
            transition(':enter', [
                style({ height: 0, opacity: 0 }),
                animate('0.5s ease-out', style({ height: '*', opacity: 1 }))
            ]),
            transition(':leave', [
                style({ height: '*', opacity: 1 }),
                animate('0.5s ease-out', style({ height: 0, opacity: 0 }))
            ])
        ])
    ]
})
export class PartialFormComponent implements OnChanges, OnInit, OnDestroy {
    /** The table whose data we are creating a form for */
    public get name(): TableName { return this.name$.getValue(); }

    /** The FormGroup from which all other controls are added */
    public get rootGroup(): FormGroup { return this.rootGroup$.getValue(); }

    @Input('name')
    public namePropertyBinding: TableName;
    private name$ = new BehaviorSubject<TableName>(null);

    @Input('rootGroup')
    public rootGroupPropertyBinding: FormGroup;
    private rootGroup$ = new BehaviorSubject<FormGroup>(null);

    @Input('role')
    public role: 'master' | 'part';

    public formSpec: FormControlSpec[];

    private sub: Subscription;
    public formArray: FormArray;

    /** A list of all bound controls for this form */
    private bindings: Binding[] = [];

    private lastValueWatchers: { [controlName: string]: Subscription } = {};

    public constructor(
        private backend: TableService,
        private formSpecGenerator: FormSpecGeneratorService,
        private fb: FormBuilder
    ) {}

    public ngOnInit() {
        const spec$ = this.name$
            .switchMap((name: TableName) =>
                this.backend.meta(name.rawName)
                    .catch((err) => {
                        // TODO handle better
                        console.error(err);
                        return Observable.never();
                    }
                ))
            .map((meta: TableMeta) => [meta, this.formSpecGenerator.generate(meta)], this);

        // Combine the latest output from the FormControlSpec array generated
        // from the table name/meta and the rootGroup
        this.sub = Observable.zip(
            spec$,
            this.rootGroup$,
        )
            .subscribe((data: [[TableMeta, FormControlSpec[]], FormGroup]) => {
                const tableMeta = data[0][0];
                this.formSpec = data[0][1];

                // Master tables start off with one entry
                const initialData = this.role === 'master' ?
                    [this.createItem(this.formSpec)] : [];

                this.formArray = this.fb.array(initialData);
                data[1].addControl(this.name.rawName, this.formArray);

                const bindings = this.formSpecGenerator.bindingConstraints(this.name.masterRawName, tableMeta);
                // If we have binding constraints, this is guaranteed to be a
                // part table
                if (bindings.length > 0) {
                    // The FormGroup for the master table is created first
                    const masterFormArray =
                        data[1].controls[this.name.masterRawName] as FormArray;

                    // The master table form array only contains one entry
                    const masterGroup = masterFormArray.at(0) as FormGroup;

                    for (const binding of bindings) {
                        // Make a note of what local control should be bound to
                        // what Observable
                        const b = {
                            controlName: binding.localColumn,
                            valueChanges: masterGroup.controls[binding.foreignColumn].valueChanges,
                            subscriptions: [],
                            lastValue: ''
                        };
                        this.bindings.push(b);

                        // Subscribe to the observable so we know what value to
                        // give a newly created bound form control
                        this.lastValueWatchers[binding.localColumn] =
                            b.valueChanges.subscribe((value) => {
                                b.lastValue = value;
                            });
                    }
                }
            });
    }

    public ngOnChanges(changes: SimpleChanges): void {
        // Changes to the root group occur when the user switches master table
        // forms
        if (changes.rootGroupPropertyBinding)
            this.rootGroup$.next(changes.rootGroupPropertyBinding.currentValue);
        if (changes.namePropertyBinding)
            this.name$.next(changes.namePropertyBinding.currentValue);
    }

    public ngOnDestroy() {
        this.sub.unsubscribe();

        for (const controlName of Object.keys(this.lastValueWatchers))
            this.lastValueWatchers[controlName].unsubscribe();

        for (const binding of this.bindings)
            for (const sub of binding.subscriptions)
                sub.unsubscribe();
    }

    public addEntry() {
        this.formArray.push(this.createItem(this.formSpec));
    }

    public removeEntry(index) {
        if (index >= this.formArray.length)
            throw new Error(`Tried to remove control at index ${index}, but ` +
                `length was ${this.formArray.length}`);

        // Make sure to unsubscribe to any bindings before removing the control.
        // For every binding, remove the subscription at the given index.
        for (const binding of this.bindings) {
            // Unsubscribe and remove the Subscription from the array
            binding.subscriptions[index].unsubscribe();
            binding.subscriptions.slice(index, 1);
        }

        this.formArray.removeAt(index);
    }

    public shouldBeHidden(formControlName: string) {
        const binding = _.find(this.bindings, (b) => b.controlName === formControlName);
        return binding !== undefined;
    }

    /**
     * Creates a new FormGroup according to the given FormControlSpecs. This
     * function automatically takes care of binding the appropriate controls.
     */
    private createItem(formSpec: FormControlSpec[]): FormGroup {
        const names = _.map(formSpec, (spec) => spec.formControlName);
        return this.fb.group(_.zipObject(
            names,
            _.map(formSpec, (spec, index) => {
                // Look for a binding for the current form control name
                const binding = _(this.bindings).find((b) => b.controlName === names[index]);

                // Fall back to the spec's initial value if there is no binding
                // for this particular control
                const initialValue = binding ? binding.lastValue : spec.initialValue;

                // Create the actual form control. Bound controls are always
                // disabled.
                const conf = {
                    value: initialValue,
                    disabled: !!spec.disabled || binding !== undefined
                };
                const control = this.fb.control(conf, spec.validation);

                if (binding !== undefined) {
                    // Do the actual "binding" -- whenever we get a new value
                    // from the master table's FormControl, update the bound
                    // control's value.
                    binding.subscriptions.push(binding.valueChanges.subscribe((value) => {
                        control.setValue(value);
                    }));
                }

                return control;
            })
        ));
    }
}
